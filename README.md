# Apps Script Cache Proxy

Google Apps Script web apps (`…/exec` URLs) take seconds to answer. This project fetches them on a schedule,
stores the latest response (Google Drive, or Cloudflare D1), and serves it instantly from a Cloudflare Worker at a permanent link:

```
https://apps-script-cache.manishx112.workers.dev/d/<token>             → latest JSON
https://apps-script-cache.manishx112.workers.dev/d/<token>?format=csv  → CSV (flat arrays)
https://apps-script-cache.manishx112.workers.dev/d/<token>/meta        → name, last success, last error, size, interval
```

Use the link in Power BI, Excel (Power Query), Looker Studio, React — anything that can GET a URL.

## How it works

```
 Admin UI (React) ──/api/*──▶ ┌──────────────── Cloudflare Worker ────────────────┐
                              │  /api/*   admin API (session cookie)              │──▶ D1 (cache-proxy):
 Dashboards ──GET /d/<token>─▶│  /d/*     memory ─▶ edge cache ─▶ KV card ─▶ Drive │    sources, logs
                              │  cron * * * * *  ─▶ fetch due Apps Script URLs   │──▶ Google Drive:
                              │  everything else ─▶ static React build (SPA)     │    one JSON per source
                              └───────────────────────────────────────────────────┘
```

- **Refresh schedule per source**: around the clock, or only on chosen weekdays and hours (e.g. Mon–Sat 10:00–18:00,
  in the source's timezone). Outside the window nothing is fetched; the link keeps serving the last data.
- **One cron (every minute)**. Refresh slots are aligned to the clock (a 15-min source runs at :00/:15/:30/:45),
  so sources with the same interval refresh together. Ticks with nothing due stop after one KV read (no database);
  public links read a small KV “link card” + Google Drive, also without the database.
  On each due slot it picks active sources whose interval has elapsed, fetches them (2 at a time, max 8 per run),
  follows the 302 to `googleusercontent.com`, validates JSON, saves it, updates status fields and writes a log.
  On failure the last good snapshot keeps being served and the error is recorded.
- **Public reads** check an in-memory cache, then the Cloudflare Cache API (60 s), then the KV link card + Drive, and only then D1.
  Responses carry `X-Cache-Fetched-At`, `X-Cache-Age-Seconds` and `Access-Control-Allow-Origin: *`.
- **Without Google Drive**, the JSON text is stored in D1, split into 500k-character chunks (a D1 row holds at most 2 MB).
  The UI warns above 5 MB.

### Optional: Google Drive storage

To keep the database small, snapshots are saved as `<source name>.json` files in a Google Drive folder
(free 15 GB, no card). Setup: [DRIVE.md](DRIVE.md). Without it, snapshots are stored in D1.

### Data model (Cloudflare D1 database `cache-proxy`, schema in [worker/src/schema.sql](worker/src/schema.sql))

| Table | Contents |
|---|---|
| `sources` | name, scriptUrl, intervalMin, token (unique), status, schedule, last fetch/success/error/duration/size, Drive file + folder id, content hash |
| `snapshots` | only without Drive: one per source — fetchedAt, sizeBytes, chunkVersion, chunkCount |
| `snapshot_chunks` | only without Drive: sourceId, version, n, text |
| `fetch_logs` | sourceId, at, ok, durationMs, sizeBytes, error — older than 7 days deleted by the cron |

Tables are created automatically the first time the Worker uses the database. Dates are milliseconds since 1970.
The data used to live in MongoDB Atlas; `npm run migrate:mongodb` copies it into D1 (MongoDB is only read).

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
│  ├─ src/snapshots.ts     Google Drive or D1 storage of the JSON
│  ├─ src/shape.ts         preview rows + CSV
│  ├─ src/auth.ts          password login, signed session cookie
│  ├─ src/db.ts            D1 queries and types
│  ├─ src/schema.sql       D1 tables
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
| `npm run secret:admin-key` | Set `ADMIN_KEY`, the dashboard password |
| `npm run secret:session` | Generate a new random `SESSION_SECRET` (signs out everyone) |
| `npm run migrate:mongodb` | One-time copy of sources + logs from MongoDB (`MONGODB_URI` in `.env`) into D1 |

In local dev the cron can be triggered with `curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"`.

## Secrets

**Easiest:** fill in `.env` (git-ignored) and run `npm run secrets` — it uploads everything.
`npm run dev` reads the same `.env`. Step-by-step deploy guide: [DEPLOY.md](DEPLOY.md).

Never stored in the repo or the React bundle (the UI has no build-time variables at all).

| Secret | Purpose | Set with |
|---|---|---|
| `ADMIN_KEY` | Dashboard password (min 12 chars) | `npm run secret:admin-key` |
| `SESSION_SECRET` | HMAC key for the session cookie | `npm run secret:session` |

`set-secret.mjs` pipes values straight to `wrangler secret put`; nothing is printed.
(If a `.dev.vars` file exists, `wrangler dev` uses it instead of `.env`.)

Changing `ADMIN_KEY` invalidates all existing sessions. Google Drive keys: see [DRIVE.md](DRIVE.md).

## Cloudflare Free plan — limits

Measured with `wrangler tail`:

| Work | CPU per invocation |
|---|---|
| Cron tick with nothing due (KV note, no database) | ~0–1 ms |
| Public link (memory / edge cache / KV card + Drive) | ~0–2 ms |
| Cron tick that refreshes sources, admin API calls (D1) | a few ms |

The Free plan allows 10 ms CPU per invocation, 50 outgoing requests per invocation (each source uses ~2–4:
Apps Script + its redirect + the Drive upload) and, for D1, 5 million rows read and 100,000 rows written per day
and 500 MB per database. A refresh writes 2–3 rows. Tuning knobs live in `wrangler.toml` `[vars]`.

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
