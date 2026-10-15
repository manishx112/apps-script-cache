# Apps Script Cache Proxy

Google Apps Script web apps (`…/exec` URLs) take seconds to answer. This project fetches them on a schedule,
stores the latest response in MongoDB Atlas, and serves it instantly from a Cloudflare Worker at a permanent link:

```
https://apps-script-cache.manishx112.workers.dev/d/<token>             → latest JSON
https://apps-script-cache.manishx112.workers.dev/d/<token>?format=csv  → CSV (flat arrays)
https://apps-script-cache.manishx112.workers.dev/d/<token>/meta        → name, last success, last error, size, interval
```

Use the link in Power BI, Excel (Power Query), Looker Studio, React — anything that can GET a URL.

## How it works

```
 Admin UI (React) ──/api/*──▶ ┌──────────────── Cloudflare Worker ────────────────┐
                              │  /api/*   admin API (session cookie)              │
 Dashboards ──GET /d/<token>─▶│  /d/*     public reads ─▶ memory ─▶ edge cache ─┐  │──▶ MongoDB Atlas
                              │  cron * * * * *  ─▶ fetch due Apps Script URLs   │  │    (cache_proxy)
                              │  everything else ─▶ static React build (SPA)     │◀─┘
                              └───────────────────────────────────────────────────┘
```

- **One cron (every minute)** picks active sources whose interval has elapsed, fetches them (2 at a time, max 10 per run),
  follows the 302 to `googleusercontent.com`, validates JSON, upserts the snapshot, updates status fields and writes a log.
  On failure the last good snapshot keeps being served and the error is recorded.
- **Public reads** check an in-memory cache, then the Cloudflare Cache API (60 s), and only then MongoDB.
  Responses carry `X-Cache-Fetched-At`, `X-Cache-Age-Seconds` and `Access-Control-Allow-Origin: *`.
  > The Cache API only takes effect on a **custom domain**; on `*.workers.dev` the in-memory layer still applies.
- **Large responses**: stored parsed when they fit a 16 MB MongoDB document; otherwise stored as text chunks in
  `snapshot_chunks` and reassembled on read. The UI warns above 5 MB.

### Optional: Google Drive storage

To keep MongoDB small, snapshots can be saved as `<source name>.json` files in a Google Drive folder
(free 15 GB, no card). Setup: [DRIVE.md](DRIVE.md). Without it, snapshots stay in MongoDB.

### Data model (database `cache_proxy`)

| Collection | Contents | Indexes |
|---|---|---|
| `sources` | name, scriptUrl, intervalMin, token, status, lastFetchedAt, lastSuccessAt, lastError, lastDurationMs, lastSizeBytes, createdAt | `token` unique; `status + lastFetchedAt` |
| `snapshots` | one per source: sourceId, fetchedAt, sizeBytes, storage (`inline`/`chunked`), data | `sourceId` unique |
| `snapshot_chunks` | sourceId, version, n, text (only for responses too big for one document) | `sourceId + version + n` |
| `fetch_logs` | sourceId, at, ok, durationMs, sizeBytes, error | TTL 7 days on `at`; `sourceId + at` |

Indexes are created automatically on the first cron run / first source.

## Project layout

```
E:\apps-script-cache
├─ worker/                 Cloudflare Worker (TypeScript)
│  ├─ src/index.ts         entry: routes + cron
│  ├─ src/admin.ts         /api/* admin routes
│  ├─ src/public.ts        /d/:token routes + caching
│  ├─ src/scheduler.ts     cron: pick due sources
│  ├─ src/refresh.ts       fetch one source, save snapshot, log
│  ├─ src/fetcher.ts       Apps Script fetch + JSON validation
│  ├─ src/snapshots.ts     inline vs chunked storage
│  ├─ src/shape.ts         preview rows + CSV
│  ├─ src/auth.ts          password login, signed session cookie
│  ├─ src/db.ts            MongoDB client, types, indexes
│  └─ public/              ← React build output (served as static assets; generated)
├─ web/                    React + Vite + Tailwind admin UI
├─ scripts/set-secret.mjs  sets secrets without showing them
├─ wrangler.toml
└─ package.json            dev / build / deploy
```

## Commands

| Command | What it does |
|---|---|
| `npm install` | Install everything (root + `web` workspace) |
| `npm run deploy` | Build the React app, typecheck + bundle the Worker, deploy |
| `npm run build` | Build only (React → `worker/public`, then Worker bundle → `dist-worker`) |
| `npm run dev` | Local dev: `wrangler dev` on :8787 + Vite on http://localhost:5173 (proxies `/api` and `/d`) |
| `npm run tail` | Live Worker logs (shows CPU time per request / cron run) |
| `npm run secret:mongodb` | Set `MONGODB_URI` (asks for the password, tests the login first) |
| `npm run secret:admin-key` | Set `ADMIN_KEY`, the dashboard password |
| `npm run secret:session` | Generate a new random `SESSION_SECRET` (signs out everyone) |

In local dev the cron can be triggered with `curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"`.

## Secrets

**Easiest:** fill in `.env` (git-ignored) and run `npm run secrets` — it tests the MongoDB login and uploads everything.
`npm run dev` reads the same `.env`. Step-by-step deploy guide: [DEPLOY.md](DEPLOY.md).

Never stored in the repo or the React bundle (the UI has no build-time variables at all).

| Secret | Purpose | Set with |
|---|---|---|
| `MONGODB_URI` | Atlas connection string | `npm run secret:mongodb` |
| `ADMIN_KEY` | Dashboard password (min 12 chars) | `npm run secret:admin-key` |
| `SESSION_SECRET` | HMAC key for the session cookie | `npm run secret:session` |

`set-secret.mjs` pipes values straight to `wrangler secret put`; nothing is printed.
(If a `.dev.vars` file exists, `wrangler dev` uses it instead of `.env`.)

Notes:
- The helper uses public DNS (1.1.1.1) for its own login test because this PC's local DNS proxy refuses SRV lookups.
- Changing `ADMIN_KEY` invalidates all existing sessions.

### Use a limited MongoDB user (recommended)

The Worker currently logs in as `manishx112_db_user` (**atlasAdmin**). If the connection string ever leaked, it would grant
full access to the whole project. To switch to a user that can only touch `cache_proxy`:

1. Atlas → **Security → Database & Network Access → Database Users → Add New Database User**
   (direct link: https://cloud.mongodb.com/v2/6ad088942b55a6b5fff917a5#/security/database/users)
2. Username `cache-proxy-worker`, **Autogenerate Secure Password** → **Copy**.
3. **Specific Privileges → Add Specific Privilege**: role `readWrite`, database `cache_proxy`, collection empty.
4. Click **Add User** at the bottom and wait until it appears in the list.
5. `npm run secret:mongodb` → paste the password. It confirms the login and write access before uploading.

## Cloudflare Free plan — known limits

Measured during setup (Step 0):

| Work | CPU per invocation |
|---|---|
| Public link served from cache | ~0–1 ms |
| Public link that reads MongoDB (cache miss) | ~20–110 ms |
| Cron run (connect + check due sources) | ~75–160 ms, more when fetching large responses |

The Free plan allows **10 ms** CPU per invocation. Cloudflare currently tolerates these bursts, but it may start rejecting
them (error 1102), which would show up as failed refreshes or 5xx on cache misses. If that happens, the fix is the Workers
Paid plan ($5/month, 30 s CPU) — no code change needed. Tuning knobs live in `wrangler.toml` `[vars]`.

## Apps Script requirements

Deploy → **New deployment → Web app**, *Execute as: Me*, *Who has access: Anyone*. `doGet` must return JSON, e.g.:

```js
function doGet() {
  const rows = SpreadsheetApp.getActive().getSheetByName("Data").getDataRange().getValues();
  return ContentService.createTextOutput(JSON.stringify(rows)).setMimeType(ContentService.MimeType.JSON);
}
```

## Security notes

- Admin session: HttpOnly, Secure, SameSite=Strict cookie, HMAC-signed, 7-day expiry; cross-site writes are rejected.
- Login: constant-time comparison, per-IP lockout after 8 failures (15 min).
- `/d/<token>` links are bearer secrets (43 random URL-safe chars). Rotate a link from the UI if it leaks;
  the old one stops working at once (cached copies expire within ~60 s).
