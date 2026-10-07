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
`main` did not until PR #3 (2026-10-07) brought the hosted server in; older branches and commits may still lack it. Deploy one without `src/server/main.ts` and `dist/server/main.js` won't exist, the startup command fails, and **every tenant drops**. The CI/CD pipeline refuses such a commit.

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

## CI/CD (GitHub Actions)

`.github/workflows/deploy.yml` deploys automatically — the manual steps below remain for rollbacks and emergencies.

| Merge / push to | Deploys to | GitHub environment |
|---|---|---|
| `dev` | `wap-pusaka-wa-connector-dev` | `development` |
| `main` | `wap-pusaka-wa-connector-prod` | `production` |

It runs only when the server's code changes (`src/**`, `package*.json`, `tsconfig.json`, `.nvmrc`, the workflow itself) — every deploy restarts the app, which drops and reconnects every tenant's WhatsApp socket, so a docs change should not. **Actions → Deploy hosted connector → Run workflow** deploys the chosen branch (`dev` or `main`) on demand.

What it does: `npm ci` + `tsc --noEmit` + a check that `src/server/main.ts` exists → `git archive` → `az webapp deploy --type zip` (Oryx builds on Azure, then one restart) → polls `/health` for up to 5 minutes. A **stopped** app is deployed but left stopped, with a warning instead of a health check.

### Setup (done 2026-10-07)

Azure sign-in is OIDC — no secret is stored in GitHub. SCM basic auth is disabled on both apps, so a publish profile cannot be used. Each environment has its own user-assigned managed identity that may deploy to its own app only.

| | `development` | `production` |
|---|---|---|
| Managed identity | `id-github-wa-connector-dev` (RG_DEV) | `id-github-wa-connector-prod` (RG_PROD) |
| `AZURE_CLIENT_ID` (environment variable) | `a0e08f1d-55f0-4975-9394-d978ff43f2c5` | `eb3a7839-107e-4222-9950-33462893d583` |
| Role | Website Contributor on `wap-pusaka-wa-connector-dev` | Website Contributor on `wap-pusaka-wa-connector-prod` |
| Deployment branches | `dev` only | `main` only |

Both environments also carry `AZURE_TENANT_ID` = `0fa1f3f9-1330-425b-876a-9ffe2e503091` and `AZURE_SUBSCRIPTION_ID` = `5b37e938-2a7d-4b6a-96b6-c2110cd12aaf` — as *variables*, not secrets: they are identifiers, not credentials. Production has no required reviewers; add them under Settings → Environments → production if PROD deploys should wait for an approval.

**The OIDC subject.** This repo uses GitHub's *immutable* subject claim, which carries the owner and repo ids:

```
repo:qlar-ai@332980671/qlar-baileys-connector@1283946688:environment:<development|production>
```

Each identity has a federated credential for that subject (`github-<env>-immutable`), plus one for the plain form `repo:qlar-ai/qlar-baileys-connector:environment:<env>` (`github-<env>`) in case the setting is switched off. Read the current prefix with:

```bash
gh api repos/qlar-ai/qlar-baileys-connector/actions/oidc/customization/sub --jq .sub_claim_prefix
```

If the login step fails with `AADSTS70021: No matching federated identity record found`, the token's subject matches neither — most likely the repo moved to another owner, or was deleted and recreated (new ids). Add a credential for the new subject:

```bash
# for PROD: RG_PROD, id-github-wa-connector-prod, production
az identity federated-credential create -g RG_DEV --identity-name id-github-wa-connector-dev -n github-development-<suffix>   --issuer https://token.actions.githubusercontent.com   --subject "<sub_claim_prefix>:environment:development"   --audiences api://AzureADTokenExchange
```

Recreating an identity from scratch: `az identity create`, then `az role assignment create --assignee-object-id <principalId> --assignee-principal-type ServicePrincipal --role "Website Contributor" --scope <web app id>`, then the federated credential above, and put its `clientId` in that environment's `AZURE_CLIENT_ID`.

---

## Deploy (manual)

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
| `UNLINKED_PAIRING_TTL_MINUTES` | — (default `10`) | — (default `10`) |
| Startup command | `node dist/server/main.js` | `node dist/server/main.js` |
| Runtime / AlwaysOn | `NODE|24-lts` / on | `NODE|24-lts` / on |

Check the live values:
```powershell
az webapp config appsettings list -g RG_PROD -n wap-pusaka-wa-connector-prod -o table
az webapp config show -g RG_PROD -n wap-pusaka-wa-connector-prod --query "{linuxFx:linuxFxVersion, startup:appCommandLine, alwaysOn:alwaysOn}" -o json
```

### `CONNECTOR_DATA_DIR=/home/data` — don't change this

The code default is `./data`, which sits inside `wwwroot` — and **zip-deploy replaces all of `wwwroot`**. On the default, every deploy wipes all tenant state and **every number has to re-pair**. `/home/data` is outside `wwwroot`, so sessions survive the deploy.

### `UNLINKED_PAIRING_TTL_MINUTES` — when an unscanned pairing is given up

A hosted pairing whose QR is never scanned (wizard closed, user went the Private route) is torn down and its folder wiped at the first QR expiry (`408`) after this many minutes — a QR series lasts ~3 minutes, so with the default 10 it goes at ~11 minutes. Before this, such a session generated QRs for nobody until the process restarted. Sessions that were ever linked are never affected. Look for `QR never scanned — pairing abandoned` in the logs.

On restore, a session folder without linked credentials (`wa_session/creds.json` carrying `me`) is wiped rather than restarted.

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
