# Deploying the Connector to DEV & PROD

How to deploy the **hosted multi-session connector server** (`src/server/main.ts`) to Azure App Service.

> This is **not** for the desktop connector (single-tenant, `src/index.ts`) that runs on a user's machine — that's covered in [README.md](../README.md).

---

## Targets

| | DEV | PROD |
|---|---|---|
| App Service | `wap-pusaka-wa-connector-dev` | `wap-pusaka-wa-connector-prod` |
| Resource group | `RG_DEV` | `RG_PROD` |
| URL | `https://wap-pusaka-wa-connector-dev.azurewebsites.net` | `https://wap-pusaka-wa-connector-prod.azurewebsites.net` |
| Kudu (SCM) | `https://wap-pusaka-wa-connector-dev.scm.azurewebsites.net` | `https://wap-pusaka-wa-connector-prod.scm.azurewebsites.net` |

Runtime: **App Service Linux, Node `NODE|24-lts`**, code lives at `/home/site/wwwroot`.
Not Docker/ACI — the `Dockerfile` in this repo isn't used yet.

---

## Prerequisites

1. `az login` done, and the right subscription selected:
   ```powershell
   az account show --query "{sub:name, id:id}" -o json
   ```
2. Be in the connector repo (its own git repo, separate from the Wisdom repo):
   ```powershell
   cd D:\Ecomindo\Wisdom\connector
   ```

---

## Check first (important)

**1. The branch must contain `src/server/`.**
Branch `main` is the desktop connector — it has **no** `src/server/main.ts`. Deploy `main` and `dist/server/main.js` won't exist, the startup command fails, and **every tenant drops**.

```powershell
git branch --show-current
git ls-files src/server        # must list main.ts, sessionManager.ts, waSession.ts, etc.
```

**2. Working tree clean and in sync with origin.**
`git archive` only ships **committed** files — uncommitted changes are silently left out.

```powershell
git status --short                                         # must be empty
git rev-list --left-right --count origin/<branch>...HEAD   # must be "0  0"
```

---

## Deploy

### DEV

```powershell
cd D:\Ecomindo\Wisdom\connector
git archive --format=zip -o ../connector-deploy-dev.zip <branch>

cd ..
az webapp deploy -g RG_DEV -n wap-pusaka-wa-connector-dev --src-path connector-deploy-dev.zip --type zip
az webapp restart -g RG_DEV -n wap-pusaka-wa-connector-dev
```

### PROD

```powershell
cd D:\Ecomindo\Wisdom\connector
git archive --format=zip -o ../connector-deploy-prod.zip <branch>

cd ..
az webapp deploy -g RG_PROD -n wap-pusaka-wa-connector-prod --src-path connector-deploy-prod.zip --type zip
az webapp restart -g RG_PROD -n wap-pusaka-wa-connector-prod
```

Replace `<branch>` with the branch you checked above (e.g. `dev-philip-baileys-v4`).

**Why `git archive`?** It ships exactly the committed tree: `package.json` + `src/` at the root, no `node_modules`, no `dist`, no `wa_session/`. TypeScript is compiled on Azure by Oryx (`typescript` is a devDependency + `SCM_DO_BUILD_DURING_DEPLOYMENT=true`), producing `dist/server/main.js` — which is what the startup command runs.

---

## Verify after deploy

The Oryx build plus session restore takes a while. The server opens its port first and reconnects sessions in the background, so `/health` can return `ok` while `sessions` is still 0 — give it a moment.

```powershell
# 1. Health check — sessions = how many tenants have reconnected
curl https://wap-pusaka-wa-connector-prod.azurewebsites.net/health

# 2. Session list
curl https://wap-pusaka-wa-connector-prod.azurewebsites.net/sessions

# 3. Logs
az webapp log tail -g RG_PROD -n wap-pusaka-wa-connector-prod
```

What to look for in the logs: `[server] starting multi-session connector` (with the right `hubUrl`, `dataDir`, `port`), then `[control] listening on port 8080`.

Finally: send and receive one real WhatsApp message through the agent.

---

## App settings (reference)

Already set on both environments — **no need to touch these** for a normal deploy.

| Setting | DEV | PROD |
|---|---|---|
| `HUB_URL` | `https://wap-pusaka-messenger-dev.azurewebsites.net/hubs/connector` | `https://wap-pusaka-messenger-prod.azurewebsites.net/hubs/connector` |
| `CONNECTOR_DATA_DIR` | `/home/data` | `/home/data` |
| `SCM_DO_BUILD_DURING_DEPLOYMENT` | `true` | `true` |
| `PORT` | `8080` | `8080` |
| `LOG_LEVEL` | `info` | `info` |
| `BAILEYS_LOG_LEVEL` | — | `debug` |
| Startup command | `node dist/server/main.js` | `node dist/server/main.js` |
| Runtime / AlwaysOn | `NODE|24-lts` / on | `NODE|24-lts` / on |

Check the live values:
```powershell
az webapp config appsettings list -g RG_PROD -n wap-pusaka-wa-connector-prod -o table
az webapp config show -g RG_PROD -n wap-pusaka-wa-connector-prod --query "{linuxFx:linuxFxVersion, startup:appCommandLine, alwaysOn:alwaysOn}" -o json
```

### `CONNECTOR_DATA_DIR=/home/data` — don't change this

The code default is `./data`, which sits inside `wwwroot` — and **zip-deploy replaces all of `wwwroot`**. On the default, every deploy wipes all tenant state and **every number has to re-pair**. `/home/data` is outside `wwwroot`, so sessions survive the deploy.

### `HUB_URL` uses the direct App Service URL

Not `api-dev.pusaka.ai` / `api.pusaka.ai`. APIM only routes the REST `/messenger/api/*` endpoints, not the SignalR hub — through the gateway you get a `404`. Also note there is **no `/messenger` prefix** on the App Service URL.

---

## Troubleshooting

**Every tenant dropped after deploy / app won't start**
Most likely `dist/server/main.js` is missing. Confirm the deployed branch has `src/server/main.ts` (see [Check first](#check-first-important)), then read the Oryx build output in the log tail.

**Every number asks to re-pair after deploy**
Check `CONNECTOR_DATA_DIR` is still `/home/data`. If it's empty or `./data`, the state was wiped by the deploy.

**A session is stuck / need to clear one tenant's state**
Use the Kudu console (`https://<app>.scm.azurewebsites.net` → Bash) and delete that tenant's folder under `/home/data`. Careful on PROD: delete only the tenant folder you mean, never all of `/home/data` — that forces every number to re-pair.

**Connector connects, then WhatsApp logs it out ~20s later**
Not a deploy problem. This is the dead-session pileup issue — look for `401` in the logs and check that tenant's pairing history.

**No logs / App Insights empty**
Rely on `az webapp log tail`. The tail usually carries a noisy Service Bus `404` error loop — filter it out:
```powershell
az webapp log tail -g RG_PROD -n wap-pusaka-wa-connector-prod | Select-String -NotMatch "ServiceBus"
```

---

## Rollback

Zip-deploy keeps no previous version. To roll back, archive the older commit and deploy again.

```powershell
cd D:\Ecomindo\Wisdom\connector
git archive --format=zip -o ../connector-rollback.zip <old-commit-sha>
cd ..
az webapp deploy -g RG_PROD -n wap-pusaka-wa-connector-prod --src-path connector-rollback.zip --type zip
az webapp restart -g RG_PROD -n wap-pusaka-wa-connector-prod
```

Because tenant state lives in `/home/data` (outside `wwwroot`), rolling back the code does not wipe sessions.

---

## Notes

- The archive also carries `dist-bundle/index.cjs` (~8.9 MB) — that's the desktop connector bundle, unused by the hosted server. Harmless, it just makes the zip bigger.
- The PROD app settings above were verified **2026-09-10**; DEV was verified **2026-08-24**. When in doubt, check live with the `az` commands above.
