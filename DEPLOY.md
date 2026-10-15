# Deploy it yourself — step by step

You can run every command below in the Antigravity terminal (or any PowerShell window).
Each step says **what to run**, **what you should see**, and **why**.

---

## 0. Open the project folder

```powershell
cd E:\apps-script-cache
```

## 1. Install the tools (first time only)

```powershell
npm install
```

✅ You should see `added … packages` and `found 0 vulnerabilities`.
*Why:* downloads React, Vite, Tailwind, the MongoDB driver and **wrangler** (Cloudflare's command-line tool) into `node_modules`.

## 2. Log in to Cloudflare (first time only)

```powershell
npx wrangler whoami
```

✅ If it shows `You are logged in … manishx112@gmail.com`, skip to step 3.
Otherwise run `npx wrangler login` — a browser tab opens, click **Allow**.
*Why:* wrangler needs permission to upload the Worker to your Cloudflare account.

## 3. Put your secrets in `.env`

Open `E:\apps-script-cache\.env` in the editor and fill in:

| Line | What to put |
|---|---|
| `MONGODB_URI` | Replace `PASSWORD` with the real password of `manishx112_db_user` (no `<` `>`). If the password contains `@ : / ? #`, write them as `%40 %3A %2F %3F %23`. |
| `ADMIN_KEY` | Any password you like, **at least 12 characters** — this is your login for the website. |
| `SESSION_SECRET` | Leave empty (`''`). |

Save the file. *Why:* `.env` is listed in `.gitignore`, so it never gets committed or put into the website.

## 4. Upload the secrets to Cloudflare

```powershell
npm run secrets
```

✅ You should see:

```
✔ Logged in as manishx112_db_user@admin
✔ Write access to the cache_proxy database confirmed.
✨ Success! Uploaded secret MONGODB_URI
✨ Success! Uploaded secret ADMIN_KEY
✔ All secrets uploaded.
```

*Why:* the Worker runs on Cloudflare's servers, not your PC, so the secrets must live there.
The script first tests the MongoDB login from your PC so a typo is caught before upload.

❌ `Atlas rejected …` → the password in `MONGODB_URI` is wrong. Fix `.env` and run again.

## 5. Build and deploy

```powershell
npm run deploy
```

This runs three things in order:

1. `vite build` — turns the React app (`web/`) into plain HTML/CSS/JS in `worker/public/`
2. `tsc` — type-checks the Worker code (`worker/src/`)
3. `wrangler deploy` — uploads the Worker **and** the website files to Cloudflare

✅ At the end you should see:

```
Deployed apps-script-cache triggers
  https://apps-script-cache.manishx112.workers.dev
  schedule: * * * * *
```

`schedule: * * * * *` is the cron that refreshes your sources every minute.

## 6. Sign in and add a source

1. Open https://apps-script-cache.manishx112.workers.dev
2. **Admin password** = the `ADMIN_KEY` you wrote in `.env`
3. **Add source** → paste your Apps Script `/exec` URL → **Test URL** → **Save source**
4. Copy the link from the source page and use it in Power BI / Excel / React.

---

## Everyday commands

| I want to… | Run |
|---|---|
| Deploy after changing code | `git add -A` → `git commit -m "…"` → `git push` (GitHub deploys it, see below). `npm run deploy` still works from your PC. |
| Change my login password or MongoDB password | edit `.env`, then `npm run secrets` |
| See live logs (requests, cron runs, CPU time) | `npm run tail` (Ctrl+C to stop) |
| Try changes on my PC before deploying | `npm run dev` → open http://localhost:5173 (uses `.env`) |
| See what's deployed / roll back | Cloudflare dashboard → Workers & Pages → apps-script-cache → Deployments |

## Auto-deploy from GitHub

The code lives at https://github.com/manishx112/apps-script-cache.
Every push to `main` runs [.github/workflows/deploy.yml](.github/workflows/deploy.yml), which builds the site and runs `npm run deploy` on GitHub's servers.

**One-time setup** (lets GitHub upload to your Cloudflare account):

1. Cloudflare dashboard → **My Profile → API Tokens → Create Token** → template **Edit Cloudflare Workers** → **Continue to summary → Create Token**. Copy the token.
2. GitHub repo → **Settings → Secrets and variables → Actions → New repository secret**
   - Name: `CLOUDFLARE_API_TOKEN`
   - Secret: the token from step 1
3. GitHub repo → **Actions → Deploy → Run workflow** to test it.

✅ The run turns green and https://apps-script-cache.manishx112.workers.dev shows your latest code.

**Everyday flow:**

```powershell
git add -A
git commit -m "describe your change"
git push
```

Watch progress under the repo's **Actions** tab (about 1–2 minutes).
*Why:* `MONGODB_URI`, `ADMIN_KEY` and `SESSION_SECRET` are already stored on Cloudflare, so GitHub never needs them. Change them only with `npm run secrets` from your PC.

## Where things are on Cloudflare

Dashboard → **Workers & Pages → apps-script-cache**:
- **Settings → Variables and Secrets** — your secrets (values are hidden) and the `[vars]` from `wrangler.toml`
- **Settings → Triggers** — the `* * * * *` cron
- **Logs / Observability** — every request and cron run with its CPU time
