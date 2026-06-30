# Pusaka Connector

A small WhatsApp connector that runs **on your own machine**. It bridges WhatsApp
(via [Baileys](https://github.com/WhiskeySockets/Baileys)) to **Messenger-BE** over a
SignalR connection, so an agent in Pusaka can send and receive WhatsApp messages
through your phone number.

```
WhatsApp  ◀──Baileys──▶  Connector (this app)  ◀──SignalR──▶  Messenger-BE  ◀──▶  Pusaka
```

---

## Prerequisites

- **Node.js 20+**
- A running **Messenger-BE** instance (the SignalR hub).
- A **pairing code** generated from **CMS-Web** (only needed the first time — see below).

Install dependencies once:

```powershell
npm install
```

---

## Running the connector

> The `--hub` value is the Messenger-BE SignalR hub URL. In local development it is
> typically `https://localhost:7193/hubs/connector`.

### 1. First run — pairing (needs a code)

The very first time, you must pair this machine to an agent using a one-time pairing
code from CMS-Web. Pass it with `--code`:

```powershell
$env:NODE_TLS_REJECT_UNAUTHORIZED=0; npx ts-node-dev --transpile-only src/index.ts --hub https://localhost:7193/hubs/connector --code 2ALWNAGK
```

What happens:
1. The connector pairs with Messenger-BE and saves the session to `session.json`.
2. A **QR code** is generated and shown in **CMS-Web** — scan it with WhatsApp on your
   phone (*Linked devices → Link a device*).
3. Once scanned, WhatsApp credentials are stored in the `wa_session/` folder.

### 2. Later runs — reconnect (no code needed)

After you've paired and scanned once, the saved `session.json` + `wa_session/` are
reused. Just omit `--code`:

```powershell
$env:NODE_TLS_REJECT_UNAUTHORIZED=0; npx ts-node-dev --transpile-only src/index.ts --hub https://localhost:7193/hubs/connector
```

The connector reconnects automatically using the existing session — no QR, no code.

> The `--hub` is even optional on later runs, because the URL is also saved into
> `session.json`. You can run with no arguments and it will reuse the saved hub URL.

---

## Why `NODE_TLS_REJECT_UNAUTHORIZED=0`?

Local Messenger-BE runs on HTTPS with a **self-signed dev certificate**. Setting
`NODE_TLS_REJECT_UNAUTHORIZED=0` tells Node to skip TLS certificate validation so the
SignalR connection can be established.

⚠️ **Development only.** Never use this against a production hub — it disables TLS
verification for the whole process. In production, point `--hub` at a properly
certificated URL and drop the env var.

---

## Re-pairing / starting fresh

If you need to link a **different** phone number, or the session is broken / logged out:

```powershell
# Remove the saved session and WhatsApp credentials
Remove-Item -Recurse -Force wa_session, session.json
```

Then run the **first-run** command again with a fresh `--code` from CMS-Web.

---

## Useful environment variables

| Variable | Default | Purpose |
|---|---|---|
| `NODE_TLS_REJECT_UNAUTHORIZED` | `1` | Set to `0` for local self-signed hub certs (dev only). |
| `MESSENGER_BE_HUB_URL` | – | Alternative to `--hub`; the hub URL to connect to. |
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

Running via the `dev` script (equivalent to the commands above):

```powershell
$env:NODE_TLS_REJECT_UNAUTHORIZED=0; npm run dev -- --hub https://localhost:7193/hubs/connector --code 2ALWNAGK
```

---

## Files this app creates (not committed)

| Path | Contents |
|---|---|
| `session.json` | Pairing session: `sessionId`, `agentId`, `hubUrl`. |
| `wa_session/` | WhatsApp auth state / credentials from Baileys. |

Both are **sensitive** and are already listed in `.gitignore` — do not commit them.
