import * as dns from 'dns'
import * as http from 'http'
import * as https from 'https'
import * as net from 'net'

/**
 * Downloads a picture on behalf of the connector so Baileys is only ever handed bytes, never a URL
 * (Baileys would otherwise fetch any URL, or read any file path, it is given, from inside our network).
 *
 * DNS rebinding: the host is resolved ONCE here, every address is validated, and the socket is then
 * opened to that validated IP literal (Host header and TLS SNI/cert check keep the original name).
 * A second resolution therefore never happens, so a name cannot answer public first and private later.
 * Limit: if a host has several public addresses we connect to the first; we do not fail over.
 */

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_MAX_REDIRECTS = 3

export interface FetchPublicImageOptions {
  maxBytes?: number
  timeoutMs?: number
  maxRedirects?: number
  lookup?: (host: string) => Promise<string[]>
  /** Test seam only: maps a VALIDATED ip to the address actually dialled (validation is unaffected). */
  dialAddress?: (validatedIp: string) => string
}

function parseV4(ip: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip)
  if (!m) return null
  const p = m.slice(1).map(Number)
  return p.every((n) => n <= 255) ? p : null
}

function parseV6(ip: string): number[] | null {
  let s = ip.toLowerCase()
  const zone = s.indexOf('%')
  if (zone >= 0) s = s.slice(0, zone)
  // Trailing dotted quad (v4-mapped etc.) becomes two hextets.
  const lastColon = s.lastIndexOf(':')
  const tail = s.slice(lastColon + 1)
  if (tail.includes('.')) {
    const v4 = parseV4(tail)
    if (!v4) return null
    s = s.slice(0, lastColon + 1) + ((v4[0] << 8) | v4[1]).toString(16) + ':' + ((v4[2] << 8) | v4[3]).toString(16)
  }
  const halves = s.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : []
  let groups: string[]
  if (halves.length === 2) {
    const fill = 8 - head.length - rest.length
    if (fill < 1) return null
    groups = [...head, ...Array(fill).fill('0'), ...rest]
  } else groups = head
  if (groups.length !== 8) return null
  const out = groups.map((g) => (/^[0-9a-f]{1,4}$/.test(g) ? parseInt(g, 16) : NaN))
  return out.some(Number.isNaN) ? null : out
}

function privateV4([a, b, c, d]: number[]): boolean {
  return (
    (a === 168 && b === 63 && c === 129 && d === 16) || // Azure wireserver
    (a === 198 && (b === 18 || b === 19)) || // benchmarking 198.18.0.0/15
    (a === 192 && b === 0 && c === 2) || // TEST-NET-1
    (a === 198 && b === 51 && c === 100) || // TEST-NET-2
    (a === 203 && b === 0 && c === 113) || // TEST-NET-3
    a === 0 || a === 10 || a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 192 && b === 0 && c === 0) ||
    a >= 224 // multicast / reserved / broadcast
  )
}

/** True for anything that is not a plain public unicast address. Unparseable input counts as private. */
export function isPrivateAddress(ip: string): boolean {
  const v4 = parseV4(ip)
  if (v4) return privateV4(v4)
  const v6 = parseV6(ip)
  if (!v6) return true
  if (v6.every((g) => g === 0)) return true // ::
  const v4Of = (hi: number, lo: number) => [hi >> 8, hi & 255, lo >> 8, lo & 255]
  if (v6.slice(0, 7).every((g) => g === 0) && v6[7] === 1) return true // ::1
  if ((v6[0] & 0xfe00) === 0xfc00) return true // fc00::/7
  if ((v6[0] & 0xffc0) === 0xfe80) return true // fe80::/10
  if ((v6[0] & 0xff00) === 0xff00) return true // multicast
  if (v6.slice(0, 5).every((g) => g === 0) && v6[5] === 0xffff) {
    return privateV4(v4Of(v6[6], v6[7])) // v4-mapped
  }
  if (v6.slice(0, 6).every((g) => g === 0)) return privateV4(v4Of(v6[6], v6[7])) // v4-compatible ::a.b.c.d
  if (v6[0] === 0x64 && v6[1] === 0xff9b && v6.slice(2, 6).every((g) => g === 0)) {
    return privateV4(v4Of(v6[6], v6[7])) // NAT64 64:ff9b::/96
  }
  if (v6[0] === 0x2002) return privateV4(v4Of(v6[1], v6[2])) // 6to4
  return false
}

function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Image download timed out')), Math.max(1, ms))
  })
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer))
}

async function defaultLookup(host: string): Promise<string[]> {
  const all = await dns.promises.lookup(host, { all: true })
  return all.map((a) => a.address)
}

export async function fetchPublicImage(
  url: string,
  opts: FetchPublicImageOptions = {},
): Promise<{ buffer: Buffer; mimeType: string }> {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS
  const lookup = opts.lookup ?? defaultLookup
  const deadline = Date.now() + timeoutMs

  let current = url
  for (let hop = 0; hop <= maxRedirects; hop++) {
    let u: URL
    try {
      u = new URL(current)
    } catch {
      throw new Error('Invalid image URL')
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      throw new Error(`Unsupported URL scheme ${u.protocol}`)
    }
    const hostname = u.hostname.replace(/^\[|\]$/g, '')
    const addresses = net.isIP(hostname) ? [hostname] : await withDeadline(lookup(hostname), deadline - Date.now())
    if (addresses.length === 0) throw new Error(`Could not resolve ${hostname}`)
    if (addresses.some(isPrivateAddress)) throw new Error('Image host resolves to a private address')

    const result = await requestOnce(u, hostname, addresses.find((a) => net.isIPv4(a)) ?? addresses[0], opts.dialAddress, maxBytes, Math.max(1, deadline - Date.now()))
    if (result.redirect) {
      current = new URL(result.redirect, u).toString()
      continue
    }
    return { buffer: result.buffer!, mimeType: result.mimeType! }
  }
  throw new Error('Too many redirects')
}

function requestOnce(
  u: URL,
  hostname: string,
  ip: string,
  dialAddress: ((ip: string) => string) | undefined,
  maxBytes: number,
  timeoutMs: number,
): Promise<{ redirect?: string; buffer?: Buffer; mimeType?: string }> {
  return new Promise((resolve, reject) => {
    const isHttps = u.protocol === 'https:'
    const lib = isHttps ? https : http
    let settled = false
    let timer: NodeJS.Timeout | undefined
    // Every outcome except a fully read body tears the connection down, so a hostile endless body
    // cannot keep the socket open after we have decided not to read it.
    const done = (fn: () => void, keepOpen = false) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (!keepOpen) req.destroy()
      fn()
    }
    const req = lib.request(
      {
        host: dialAddress ? dialAddress(ip) : ip,
        port: u.port || (isHttps ? 443 : 80),
        path: `${u.pathname}${u.search}`,
        method: 'GET',
        headers: { Host: u.host, Accept: 'image/*', 'User-Agent': 'qlar-connector' },
        agent: false,
        ...(isHttps && !net.isIP(hostname) ? { servername: hostname } : {}),
      },
      (res) => {
        const status = res.statusCode ?? 0
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume()
          done(() => resolve({ redirect: res.headers.location }))
          return
        }
        if (status !== 200) {
          res.resume()
          done(() => reject(new Error(`Image request failed with status ${status}`)))
          return
        }
        const mimeType = String(res.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase()
        if (!mimeType.startsWith('image/')) {
          res.resume()
          done(() => reject(new Error(`Unexpected content-type ${mimeType || '(none)'}`)))
          return
        }
        const declared = Number(res.headers['content-length'])
        if (Number.isFinite(declared) && declared > maxBytes) {
          res.resume()
          done(() => reject(new Error('Image too large')))
          return
        }
        const chunks: Buffer[] = []
        let total = 0
        res.on('data', (c: Buffer) => {
          total += c.length
          if (total > maxBytes) {
            done(() => reject(new Error('Image too large')))
            return
          }
          chunks.push(c)
        })
        res.on('end', () => done(() => resolve({ buffer: Buffer.concat(chunks), mimeType }), true))
        res.on('error', (e) => done(() => reject(e)))
        res.on('aborted', () => done(() => reject(new Error('Image download aborted'))))
      },
    )
    timer = setTimeout(() => {
      done(() => reject(new Error('Image download timed out')))
    }, timeoutMs)
    req.on('error', (e) => done(() => reject(e)))
    req.end()
  })
}
