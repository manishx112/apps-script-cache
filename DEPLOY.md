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
| Deploy after changing code | `npm run deploy` |
| Change my login password or MongoDB password | edit `.env`, then `npm run secrets` |
| See live logs (requests, cron runs, CPU time) | `npm run tail` (Ctrl+C to stop) |
| Try changes on my PC before deploying | `npm run dev` → open http://localhost:5173 (uses `.env`) |
| See what's deployed / roll back | Cloudflare dashboard → Workers & Pages → apps-script-cache → Deployments |

## Where things are on Cloudflare

Dashboard → **Workers & Pages → apps-script-cache**:
- **Settings → Variables and Secrets** — your secrets (values are hidden) and the `[vars]` from `wrangler.toml`
- **Settings → Triggers** — the `* * * * *` cron
- **Logs / Observability** — every request and cron run with its CPU time
