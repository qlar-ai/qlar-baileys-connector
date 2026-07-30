import makeWASocket, {
  areJidsSameUser,
  Browsers,
  DisconnectReason,
  fetchLatestBaileysVersion,
  isJidGroup,
  makeCacheableSignalKeyStore,
  proto,
  useMultiFileAuthState,
  WAMessage,
  WASocket,
} from '@whiskeysockets/baileys'
import * as fs from 'fs'
import * as path from 'path'
import pino from 'pino'
import { APP_DIR } from './appDir'

const WA_SESSION_DIR = path.join(APP_DIR, 'wa_session')

export interface InboundMessage {
  from: string
  text: string
  messageId: string
  /** Id of the message this one quotes, when the user replied to something. */
  quotedMessageId?: string
  /** Text of the quoted message, so the agent can see what is being replied to. */
  quotedText?: string
  /** True when `from` is a group rather than an individual chat. */
  isGroup?: boolean
  /** Group subject, when known. Empty until the metadata lookup has warmed. */
  groupName?: string
  /** The individual who actually sent this, which in a group is not `from`. */
  senderJid?: string
  /** That individual's WhatsApp display name. */
  senderName?: string
  /**
   * Whether this message addresses the bot — resolved here rather than upstream because
   * only the connector knows the bot's own JID and LID.
   */
  isAddressedToBot?: boolean
}

export type OnQr = (qrBase64: string) => void
export type OnConnected = (phoneNumber: string) => void
export type OnDisconnected = (reason: string, shouldReconnect: boolean) => void
export type OnMessage = (msg: InboundMessage) => void

// ───────────────────────────────────────────────────────────────────────────
// Diagnostics
//
// `log`            — our own connector tracing (human-facing). Verbosity via
//                    WA_LOG_LEVEL (default 'debug'): trace|debug|info|warn|error.
// `baileysLogger`  — Baileys' OWN internal logger. It prints the RAW WhatsApp
//                    protocol frames Baileys exchanges with WA servers. Off by
//                    default (extremely chatty). Set BAILEYS_LOG_LEVEL=trace (or
//                    debug) to see the actual request/response traffic — this is
//                    the ground truth for "what did WhatsApp's API reply".
// `WA_DEBUG_PROBE=1` — additionally runs onWhatsApp() before each send (a network
//                    round-trip that asks WA whether the number exists).
// ───────────────────────────────────────────────────────────────────────────
const log = pino({ level: process.env.WA_LOG_LEVEL ?? 'debug' })
const baileysLogger = pino({ level: process.env.BAILEYS_LOG_LEVEL ?? 'silent' })

// proto.WebMessageInfo.Status enum → readable name.
const MESSAGE_STATUS: Record<number, string> = {
  0: 'ERROR',
  1: 'PENDING',
  2: 'SERVER_ACK', // reached WhatsApp servers
  3: 'DELIVERY_ACK', // delivered to the recipient's device
  4: 'READ',
  5: 'PLAYED',
}
function statusName(status?: number | null): string {
  if (status === null || status === undefined) return 'UNKNOWN'
  return MESSAGE_STATUS[status] ?? `UNKNOWN(${status})`
}

// Fully expand an error — Baileys throws Boom errors that hide the real cause
// inside nested .output / .data fields.
function describeError(err: unknown): Record<string, unknown> {
  if (err instanceof Error) {
    const e = err as any
    return {
      name: err.name,
      message: err.message,
      statusCode: e?.output?.statusCode ?? e?.statusCode,
      boomPayload: e?.output?.payload,
      data: e?.data,
      stack: err.stack,
    }
  }
  return { raw: String(err) }
}

// Cache of recently sent/seen messages so getMessage() can answer retry receipts
// (a recipient device that fails to decrypt asks us to re-send). Required for
// reliable delivery; replaces Baileys' removed makeInMemoryStore.
const messageStore = new Map<string, proto.IMessage>()

// Full inbound messages kept so a later reply can quote them. Baileys needs the whole
// WAMessage (key + content) to build the quote, not just the content `messageStore` holds.
const quotableStore = new Map<string, WAMessage>()

function cacheQuotable(msg: WAMessage): void {
  const id = msg.key?.id
  if (!id) return

  if (quotableStore.size > 500) {
    const oldest = quotableStore.keys().next().value
    if (oldest !== undefined) quotableStore.delete(oldest)
  }

  quotableStore.set(id, msg)
}

// Group subjects, warmed in the background. A miss just means the first message from a group
// carries no name — never worth blocking message delivery on a metadata round-trip.
const groupSubjects = new Map<string, string>()

/**
 * Returns the cached group subject, kicking off a lookup when it is not known yet.
 * Deliberately non-blocking so later messages cannot overtake earlier ones.
 */
function groupSubject(jid: string): string {
  const cached = groupSubjects.get(jid)

  if (cached !== undefined) return cached

  // Reserve the key so concurrent messages don't each fire their own lookup.
  groupSubjects.set(jid, '')

  void activeSocket
    ?.groupMetadata(jid)
    .then((meta) => groupSubjects.set(jid, meta?.subject ?? ''))
    .catch((err) => log.warn({ err, jid }, '[wa] group metadata lookup failed'))

  return ''
}

/**
 * Whether a group message actually addresses the bot.
 *
 * Two ways count, because both are how people really summon a bot in a group:
 *   1. an @mention of the bot;
 *   2. a reply to one of the bot's own messages.
 *
 * The bot has two identities — its phone JID and its LID — and a mention may arrive as either,
 * so both are compared. Matching only the phone number would leave the bot deaf in every
 * LID-migrated group.
 */
function isAddressedToBot(contextInfo: proto.IContextInfo | null | undefined): boolean {
  const me = [activeSocket?.user?.id, activeSocket?.user?.lid].filter(Boolean) as string[]

  if (me.length === 0) return false

  const mentioned = contextInfo?.mentionedJid ?? []

  if (mentioned.some((jid) => me.some((mine) => areJidsSameUser(jid, mine)))) return true

  const quotedAuthor = contextInfo?.participant

  return !!quotedAuthor && me.some((mine) => areJidsSameUser(quotedAuthor, mine))
}

/** WhatsApp hangs contextInfo off whichever content type carries the text. */
function contextInfoOf(message: proto.IMessage): proto.IContextInfo | null | undefined {
  return (
    message.extendedTextMessage?.contextInfo ??
    message.imageMessage?.contextInfo ??
    message.videoMessage?.contextInfo ??
    message.documentMessage?.contextInfo
  )
}

/** Pulls the reply context out of an inbound message. */
function readQuoteContext(
  contextInfo: proto.IContextInfo | null | undefined,
): Pick<InboundMessage, 'quotedMessageId' | 'quotedText'> {
  const quoted = contextInfo?.quotedMessage

  if (!contextInfo?.stanzaId || !quoted) return {}

  return {
    quotedMessageId: contextInfo.stanzaId,
    quotedText:
      quoted.conversation ??
      quoted.extendedTextMessage?.text ??
      quoted.imageMessage?.caption ??
      quoted.videoMessage?.caption ??
      '',
  }
}
function cacheMessage(id: string | null | undefined, message: proto.IMessage | null | undefined): void {
  if (!id || !message) return
  if (messageStore.size > 2000) {
    const oldest = messageStore.keys().next().value
    if (oldest !== undefined) messageStore.delete(oldest)
  }
  messageStore.set(id, message)
}

let activeSocket: WASocket | null = null

export async function startWhatsApp(
  onQr: OnQr,
  onConnected: OnConnected,
  onDisconnected: OnDisconnected,
  onMessage: OnMessage,
): Promise<void> {
  fs.mkdirSync(WA_SESSION_DIR, { recursive: true })

  const { state, saveCreds } = await useMultiFileAuthState(WA_SESSION_DIR)
  const { version } = await fetchLatestBaileysVersion()
  log.info(
    { waVersion: version, sessionDir: WA_SESSION_DIR, node: process.version },
    '[wa] startWhatsApp — creating socket',
  )

  const socket = makeWASocket({
    version,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, baileysLogger as any),
    },
    logger: baileysLogger as any,
    browser: Browsers.ubuntu('Chrome'),
    generateHighQualityLinkPreview: true,
    // Serve cached messages so Baileys can fulfil retry receipts (real delivery).
    getMessage: async (key) => messageStore.get(key.id ?? '') ?? undefined,
  })

  activeSocket = socket

  socket.ev.on('creds.update', saveCreds)

  socket.ev.on('connection.update', async (update) => {
    const { connection, qr, lastDisconnect } = update

    log.debug(
      {
        connection,
        hasQr: !!qr,
        isNewLogin: (update as any).isNewLogin,
        receivedPendingNotifications: update.receivedPendingNotifications,
        lastDisconnect: lastDisconnect ? describeError(lastDisconnect.error) : undefined,
      },
      '[conn] connection.update',
    )

    if (qr) {
      // Convert raw QR string to base64 data URL for display in CMS-Web
      const qrcode = await import('qrcode')
      const qrBase64 = await qrcode.toDataURL(qr)
      onQr(qrBase64)
    }

    if (connection === 'open') {
      log.info(
        {
          meId: socket.user?.id,
          meLid: (socket.user as any)?.lid,
          meName: socket.user?.name,
        },
        '[conn] ✅ connection OPEN — socket ready to send/receive',
      )
      const phoneNumber = socket.user?.id?.split(':')[0] ?? ''
      onConnected(phoneNumber)
    }

    if (connection === 'close') {
      activeSocket = null
      const statusCode = (lastDisconnect?.error as any)?.output?.statusCode
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut
      const reason = shouldReconnect ? `disconnected (code ${statusCode})` : 'logged out'
      log.warn(
        { statusCode, shouldReconnect, reason, error: describeError(lastDisconnect?.error) },
        '[conn] ❌ connection CLOSE — activeSocket set to null (sends will fail until reconnect)',
      )
      onDisconnected(reason, shouldReconnect)
    }
  })

  socket.ev.on('messages.upsert', ({ messages, type }) => {
    // Cache every message (sent + received) so getMessage() can answer retries.
    for (const msg of messages) cacheMessage(msg.key.id, msg.message)
    log.debug({ type, count: messages.length }, '[in] messages.upsert')
    if (type !== 'notify') return

    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue

      const from = msg.key.remoteJid ?? ''
      const text =
        msg.message.conversation ??
        msg.message.extendedTextMessage?.text ??
        msg.message.imageMessage?.caption ??
        ''

      if (!text || !from) continue

      // Kept before the callback so the reply that follows can quote this exact message.
      cacheQuotable(msg)

      const contextInfo = contextInfoOf(msg.message)
      const isGroup = isJidGroup(from) ?? false

      log.info(
        { from, messageId: msg.key.id, isGroup, textPreview: text.slice(0, 120) },
        '[in] ← inbound message forwarded to hub',
      )

      onMessage({
        from,
        text,
        messageId: msg.key.id ?? '',
        ...readQuoteContext(contextInfo),
        isGroup,
        // In a group `from` is the group itself, so the individual comes off the key.
        senderJid: isGroup ? (msg.key.participant ?? '') : from,
        senderName: msg.pushName ?? '',
        groupName: isGroup ? groupSubject(from) : '',
        // Individual chats are always addressed to the bot; groups have to earn it.
        isAddressedToBot: isGroup ? isAddressedToBot(contextInfo) : true,
      })
    }
  })

  // Outbound delivery lifecycle — this is WhatsApp telling us what happened to a
  // message WE sent. Cross-reference the `id` here with the messageId logged at
  // STEP 4 of sendMessage(). If you only ever see SERVER_ACK and never
  // DELIVERY_ACK, the message reached WhatsApp's servers but never reached the
  // recipient's device.
  socket.ev.on('messages.update', (updates) => {
    for (const u of updates) {
      log.info(
        {
          id: u.key?.id,
          remoteJid: u.key?.remoteJid,
          fromMe: u.key?.fromMe,
          status: u.update?.status,
          statusName: statusName(u.update?.status as number | null | undefined),
          update: u.update,
        },
        '[ack] messages.update — WhatsApp delivery/status change',
      )
    }
  })

  socket.ev.on('message-receipt.update', (updates) => {
    for (const u of updates) {
      log.info(
        {
          id: u.key?.id,
          remoteJid: u.key?.remoteJid,
          fromMe: u.key?.fromMe,
          receipt: u.receipt,
        },
        '[ack] message-receipt.update — per-recipient receipt',
      )
    }
  })
}

/**
 * Sends a text message, optionally as a WhatsApp reply to an earlier message.
 *
 * `quotedMessageId` is resolved against the inbound cache. An id that is no longer cached
 * (older than the last 500 messages, or lost to a restart) degrades to a normal message
 * rather than failing the send — the reply arriving unquoted beats it not arriving.
 */
export async function sendMessage(to: string, text: string, quotedMessageId?: string): Promise<void> {
  const startedAt = Date.now()

  // ── STEP 1: BEFORE PAYLOAD — what we were asked to send ────────────────────
  log.info(
    { to, textLength: text?.length ?? 0, textPreview: (text ?? '').slice(0, 200) },
    '[send] ▶ STEP 1 — sendMessage() invoked',
  )

  if (!activeSocket) {
    log.error({ to }, '[send] ✖ ABORT — activeSocket is null (WhatsApp socket not connected)')
    throw new Error('WhatsApp socket is not connected')
  }

  // Use the JID as-is if it already has a suffix (@s.whatsapp.net or @lid), otherwise default to @s.whatsapp.net
  const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`

  // ── STEP 2: socket + JID state right before sending ────────────────────────
  const ws = (activeSocket as any).ws
  log.debug(
    {
      to,
      resolvedJid: jid,
      jidType: jid.endsWith('@lid') ? 'lid' : jid.endsWith('@g.us') ? 'group' : 'pn',
      wsReadyState: ws?.readyState, // 0 CONNECTING, 1 OPEN, 2 CLOSING, 3 CLOSED
      wsIsOpen: ws?.readyState === 1,
      meId: activeSocket.user?.id,
      meLid: (activeSocket.user as any)?.lid,
    },
    '[send] STEP 2 — JID resolved + socket state (before sending payload)',
  )

  // ── STEP 2b (opt-in): ask WhatsApp whether this number exists / its real JID.
  // Extra network round-trip; enable with WA_DEBUG_PROBE=1.
  if (process.env.WA_DEBUG_PROBE === '1') {
    try {
      const probe = await activeSocket.onWhatsApp(jid)
      log.debug({ jid, probe }, '[send] STEP 2b — onWhatsApp() existence probe')
    } catch (e) {
      log.warn({ jid, error: describeError(e) }, '[send] STEP 2b — onWhatsApp() probe failed')
    }
  }

  const quoted = quotedMessageId ? quotableStore.get(quotedMessageId) : undefined

  if (quotedMessageId && !quoted) {
    log.warn({ quotedMessageId }, '[send] quoted message not in cache — sending unquoted')
  }

  // ── STEP 3: the actual payload leaving for WhatsApp ────────────────────────
  log.debug(
    { jid, payload: { text }, quotingMessageId: quotedMessageId ?? null, quoteResolved: !!quoted },
    '[send] STEP 3 — calling sock.sendMessage() (payload about to be encrypted + pushed to WhatsApp)',
  )

  try {
    const result = await activeSocket.sendMessage(jid, { text }, quoted ? { quoted } : undefined)
    cacheMessage(result?.key?.id, result?.message)
    log.info(`test phil ${JSON.stringify(result)}`)

    // ── STEP 4: AFTER PAYLOAD — what Baileys returned (the local WA stanza) ───
    log.info(
      {
        to,
        jid,
        elapsedMs: Date.now() - startedAt,
        messageId: result?.key?.id,
        remoteJid: result?.key?.remoteJid,
        fromMe: result?.key?.fromMe,
        status: result?.status,
        statusName: statusName(result?.status as number | null | undefined),
      },
      '[send] ✔ STEP 4 — sock.sendMessage() RESOLVED (Baileys built + queued the stanza)',
    )
    // Full WebMessageInfo for deep inspection (visible at debug level).
    log.debug({ jid, fullResult: result }, '[send] STEP 4b — full WebMessageInfo returned by Baileys')

    log.info(
      {
        messageId: result?.key?.id,
        note: 'Now watch [ack] messages.update for this id: SERVER_ACK = reached WA servers, DELIVERY_ACK = reached recipient device. No DELIVERY_ACK ⇒ it never reached the user.',
      },
      '[send] STEP 5 — awaiting async delivery acks from WhatsApp',
    )
  } catch (err) {
    // ── STEP 4 (failure): the push to WhatsApp threw ─────────────────────────
    log.error(
      { to, jid, elapsedMs: Date.now() - startedAt, error: describeError(err) },
      '[send] ✖ STEP 4 — sock.sendMessage() THREW (failed to push payload to WhatsApp)',
    )
    throw err
  }
}

export async function logout(): Promise<void> {
  if (activeSocket) {
    try { await activeSocket.logout() } catch { /* already disconnected */ }
    activeSocket = null
  }
  if (fs.existsSync(WA_SESSION_DIR)) {
    fs.rmSync(WA_SESSION_DIR, { recursive: true, force: true })
  }
}

// Local "Clear Session" button — a hard reset the user can trigger even when
// there's no live WhatsApp socket to call .logout() on (e.g. it never
// connected, or WhatsApp already dropped it). Just ends the socket if any and
// wipes the on-disk auth state, same end result as the manual
// `Remove-Item wa_session` step, without hitting the WhatsApp API.
export function resetLocalWaSession(): void {
  stopWhatsApp()
  if (fs.existsSync(WA_SESSION_DIR)) {
    fs.rmSync(WA_SESSION_DIR, { recursive: true, force: true })
  }
}

export function stopWhatsApp(): void {
  if (activeSocket) {
    try { activeSocket.end(undefined) } catch { /* ignore */ }
    activeSocket = null
  }
}
