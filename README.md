# Pusaka Connector

A small WhatsApp connector that runs **on your own machine**. It bridges WhatsApp
(via [Baileys](https://github.com/WhiskeySockets/Baileys)) to **Messenger-BE** over a
SignalR connection, so a Pusaka agent can send and receive WhatsApp messages through
your phone number.

```
WhatsApp  ◀──Baileys──▶  Connector (this app)  ◀──SignalR──▶  Messenger-BE  ◀──▶  Pusaka
```

---

## Quick start

**Prerequisites:** Node.js 20+, and a one-time **pairing code** from CMS-Web
(*Connect WhatsApp* on your agent — valid 10 minutes).

```powershell
npm install   # once
```

**1. First run — pair this machine** (needs `--code`):

```powershell
npx ts-node-dev --transpile-only src/index.ts --hub https://wap-pusaka-messenger-dev.azurewebsites.net/hubs/connector --code <PAIRING_CODE>
```

A **QR code** then appears in CMS-Web — scan it with WhatsApp (*Linked devices → Link a device*).

**2. Later runs — reconnect** (no code, no hub needed — both are saved in `session.json`):

```powershell
npx ts-node-dev --transpile-only src/index.ts
```

That covers normal use. Everything below is detail and reference.

---

## Which `--hub` URL?

`--hub` is the Messenger-BE SignalR hub URL. Pick it by environment:

| Environment | `--hub` value | TLS bypass needed? |
|---|---|---|
| **DEV** | `https://wap-pusaka-messenger-dev.azurewebsites.net/hubs/connector` | No (valid cert) |
| **Local** | `https://localhost:7193/hubs/connector` | Yes — prefix `$env:NODE_TLS_REJECT_UNAUTHORIZED=0;` |

Local example (Messenger-BE running on your machine):

```powershell
$env:NODE_TLS_REJECT_UNAUTHORIZED=0; npx ts-node-dev --transpile-only src/index.ts --hub https://localhost:7193/hubs/connector --code <PAIRING_CODE>
```

> **DEV uses the direct App Service URL, not `api-dev.pusaka.ai`.** The API gateway
> (APIM) only routes the REST `/messenger/api/*` endpoints — not the SignalR hub — so
> `https://api-dev.pusaka.ai/messenger/hubs/connector` returns `404` until a WebSocket
> route is added to APIM. Note there is **no `/messenger` prefix** on the App Service URL.

---

## First run vs. reconnect

**First run (pairing)** — `--code` required:
1. The connector pairs with Messenger-BE and saves the session to `session.json`.
2. A **QR code** appears in **CMS-Web** — scan it with WhatsApp (*Linked devices → Link a device*).
3. WhatsApp credentials are stored in the `wa_session/` folder.

**Reconnect** — `--code` omitted:
- Reads `sessionId` + `agentId` from `session.json` and reuses `wa_session/` — no QR, no code.
- `--hub` is also optional (the URL is saved in `session.json`), so running with **no arguments** reconnects to the last hub used.

---

## Starting fresh / re-pairing

To link a **different** phone number, or if the session is broken / logged out, delete
**both** of the connector's persisted files — they are the **only** two it creates:

```powershell
Remove-Item -Recurse -Force wa_session, session.json
```

Then run the **first-run** command again with a fresh `--code` from CMS-Web.

Deleting only one leaves you half-reset:
- Remove `session.json` only → re-pairs with a new `--code`, but reuses the old WhatsApp login (no new QR).
- Remove `wa_session/` only → keeps the existing pairing, but Baileys generates a new QR to scan.

---

## Why `NODE_TLS_REJECT_UNAUTHORIZED=0`?

Local Messenger-BE runs on HTTPS with a **self-signed dev certificate**. Setting
`NODE_TLS_REJECT_UNAUTHORIZED=0` tells Node to skip TLS certificate validation so the
SignalR connection can be established.

⚠️ **Local dev only.** It disables TLS verification for the whole process. Against
DEV / production (`*.azurewebsites.net` and other properly-certificated hosts),
**drop it**.

---

## Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `MESSENGER_BE_HUB_URL` | – | Alternative to `--hub`; the hub URL to connect to. |
| `NODE_TLS_REJECT_UNAUTHORIZED` | `1` | Set to `0` for local self-signed hub certs (dev only). |
| `WA_LOG_LEVEL` | `debug` | Connector's own log verbosity: `trace`/`debug`/`info`/`warn`/`error`. |
| `BAILEYS_LOG_LEVEL` | `silent` | Set to `debug`/`trace` to see raw WhatsApp protocol traffic. |
| `WA_DEBUG_PROBE` | – | Set to `1` to verify a number exists on WhatsApp before each send. |

---

## npm scripts

| Command | Description |
|---|---|
| `npm run dev` | Run in watch mode with `ts-node-dev` (pass args after `--`). |
| `npm run build` | Compile TypeScript to `dist/`. |
| `npm run build:exe` | Build standalone executables into `bin/` (Windows/Linux/macOS). |

Equivalent run via the `dev` script:

```powershell
npm run dev -- --hub https://wap-pusaka-messenger-dev.azurewebsites.net/hubs/connector --code <PAIRING_CODE>
```

---

## Files this app creates (not committed)

| Path | Contents |
|---|---|
| `session.json` | Pairing session: `sessionId`, `agentId`, `hubUrl`. |
| `wa_session/` | WhatsApp auth state / credentials from Baileys. |

These are the **only** files the connector persists, and both are **sensitive** —
they're already in `.gitignore`; do not commit them. To wipe them, see
[Starting fresh / re-pairing](#starting-fresh--re-pairing).
