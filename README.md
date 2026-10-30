# Qlar WhatsApp Connector

Connect one WhatsApp number to a Qlar agent from your own machine, so the WhatsApp session runs on
your own network and IP address.

The connector runs next to you and links your number through WhatsApp's "Linked devices". Every
connection it makes is **outbound** (HTTPS and WebSocket to Qlar and to WhatsApp). It listens on no
port, so it needs no firewall rule, certificate or DNS entry.

- **One number per connector.** One container, or one state directory, holds one number. To link
  another number, run a second container or use another state directory.
- **The link survives restarts.** The paired session is stored in the state volume or directory.
  After a restart the connector reconnects by itself and you do not scan again.
- **Keep it running.** Stopping the connector disconnects the number from your agent until you
  start it again.

## Requirements

- Docker, or Node.js 24 or newer
- Outbound HTTPS to the Qlar address shown in the CMS, and to WhatsApp
- The phone with the WhatsApp number, with an internet connection, to scan one QR code

## Install and connect

The Qlar CMS (agent -> Channels -> WhatsApp -> Private) prints these lines with your own address and
a one-time code that expires after 10 minutes. Paste them as shown; the CMS then waits for the
connector and shows the QR code to scan.

**Docker**

```bash
docker run -d --name qlar-connector --restart unless-stopped -e QLAR_HUB_URL=<address from the CMS> -e QLAR_PAIRING_CODE=<code from the CMS> -v qlar-connector-state:/state ghcr.io/qlar-ai/qlar-connector:<version> enroll
docker logs -f qlar-connector
```

**Node.js**

```bash
curl -L -o qlar-connector.cjs https://github.com/qlar-ai/qlar-baileys-connector/releases/download/v<version>/qlar-connector.cjs
node qlar-connector.cjs version
node qlar-connector.cjs enroll --hub <address from the CMS> --code <code from the CMS>
```

Then, on the phone: WhatsApp -> Linked devices -> Link a device, and scan the QR code shown in the
CMS.

## Commands

| Command | What it does |
|---|---|
| `enroll` | Links this machine to your agent with the pairing code, then keeps running. Safe to run again: if a number is already linked here, the code is ignored and the stored session reconnects. |
| `run` | Reconnects the number that is already linked. Use it after a restart if you did not start the connector with `enroll`. |
| `version` | Prints the connector version. |

Settings can be flags or environment variables; a flag wins.

| Flag | Environment variable | Meaning |
|---|---|---|
| `--hub` | `QLAR_HUB_URL` | The Qlar address shown in the CMS. |
| `--code` | `QLAR_PAIRING_CODE` | The one-time pairing code. Only needed to link a number. |
| `--state-dir` | `CONNECTOR_DATA_DIR` | Where the paired session is stored. Docker: `/state`. Node.js: `./state`. |

## After a restart

- Docker: the container restarts by itself (`--restart unless-stopped`). To start it by hand:
  `docker start qlar-connector`.
- Node.js: run `node qlar-connector.cjs run --hub <address>` from the folder you installed it in. You
  do not need a new code.

## Upgrading

Docker: stop and remove the container (`docker rm -f qlar-connector`), then run the install line
again with the new `<version>`. The `qlar-connector-state` volume keeps your linked number.
Node.js: download the new `qlar-connector.cjs` over the old one and start it again with `run`.

## Linking a different number

Remove the old link first (in the CMS, or on the phone under Linked devices), then either use a new
state volume or directory, or delete the old one. A state directory that already holds a number
ignores a new pairing code.

## Verifying a download

Each release publishes `qlar-connector.sha256` next to `qlar-connector.cjs`:

```bash
sha256sum -c qlar-connector.sha256
```

## Troubleshooting

| You see | Do this |
|---|---|
| `The pairing code is invalid or has expired` | Create a new code in the CMS and run the new command. With Docker, remove the old container first (`docker rm -f qlar-connector`), or the name is already taken. The container stays up and prints this message instead of restarting in a loop. |
| `Could not reach the Qlar hub at ...` | Check that this machine can make outbound HTTPS connections to that address. |
| `Node 24 or newer is required` | Upgrade Node.js, or use the Docker install. |
| `Nothing is enrolled in this state directory` | You ran `run` before `enroll`, or you are in a different folder or volume. Run `enroll` with a code. |
