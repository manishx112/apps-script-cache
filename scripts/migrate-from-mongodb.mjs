#!/usr/bin/env node
// One-time copy of the app's data from MongoDB Atlas (database cache_proxy) into Cloudflare D1.
//
//   node scripts/migrate-from-mongodb.mjs            copy into the live D1 database (--remote)
//   node scripts/migrate-from-mongodb.mjs --local    copy into the local D1 used by `npm run dev`
//
// Reads MONGODB_URI from .env (never printed). Copies sources (same ids and tokens, so every public
// link keeps working) and the last 7 days of fetch logs. MongoDB itself is only read, never changed,
// so it stays as a backup. Running it again replaces the copied rows with MongoDB's version.
import { spawnSync } from "node:child_process";
import dns from "node:dns";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATABASE = "cache-proxy";
const local = process.argv.includes("--local");
const fail = (msg) => {
  console.error(`\x1b[31m✘\x1b[0m ${msg}`);
  process.exit(1);
};
const ok = (msg) => console.log(`\x1b[32m✔\x1b[0m ${msg}`);

function readEnv() {
  const file = join(ROOT, ".env");
  if (!existsSync(file)) fail("No .env file.");
  const out = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trimStart().startsWith("#")) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

const uri = (readEnv().MONGODB_URI ?? "").trim();
if (!uri.startsWith("mongodb")) fail("MONGODB_URI is missing from .env.");

// Some PCs route DNS through a local proxy that refuses SRV lookups; use public DNS for Atlas.
dns.setServers(["1.1.1.1", "8.8.8.8"]);

/** SQL literal. */
const q = (v) => {
  if (v === null || v === undefined) return "NULL";
  if (v instanceof Date) return String(v.getTime());
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  if (typeof v === "boolean") return v ? "1" : "0";
  return `'${String(v).replace(/'/g, "''")}'`;
};

const { MongoClient } = await import("mongodb");
const client = new MongoClient(uri, { serverSelectionTimeoutMS: 15_000, appName: "apps-script-cache-migrate" });
let sources, logs;
try {
  await client.connect();
  const db = client.db("cache_proxy");
  sources = await db.collection("sources").find({}).toArray();
  logs = await db
    .collection("fetch_logs")
    .find({ at: { $gte: new Date(Date.now() - 7 * 24 * 3600_000) } })
    .toArray();
} catch (err) {
  const msg = String(err?.message ?? err).split(uri).join("[MONGODB_URI]");
  fail(`Could not read MongoDB: ${msg.replace(/\/\/[^/@\s]+@/g, "//[credentials]@")}`);
} finally {
  await client.close().catch(() => {});
}
ok(`Read ${sources.length} source(s) and ${logs.length} fetch log(s) from MongoDB.`);

const noDrive = sources.filter((s) => !s.driveFileId);
if (noDrive.length) {
  console.log(`  Note: ${noDrive.length} source(s) have no Google Drive file yet; their data is fetched again on the next refresh.`);
}

const schema = readFileSync(join(ROOT, "worker", "src", "schema.sql"), "utf8");
const lines = [schema];
const ids = sources.map((s) => q(s._id.toHexString()));
if (ids.length) {
  // Replace earlier copies of the same sources (and their logs) so a re-run does not duplicate logs.
  lines.push(`DELETE FROM fetch_logs WHERE sourceId IN (${ids.join(", ")});`);
}
for (const s of sources) {
  const row = {
    id: s._id.toHexString(),
    name: s.name,
    scriptUrl: s.scriptUrl,
    intervalMin: s.intervalMin,
    token: s.token,
    status: s.status === "paused" ? "paused" : "active",
    lastFetchedAt: s.lastFetchedAt ?? null,
    lastSuccessAt: s.lastSuccessAt ?? null,
    lastError: s.lastError ?? null,
    lastDurationMs: s.lastDurationMs ?? null,
    lastSizeBytes: s.lastSizeBytes ?? null,
    createdAt: s.createdAt ?? new Date(),
    driveFileId: s.driveFileId ?? null,
    driveFolderId: s.driveFolderId ?? null,
    driveContentHash: s.driveContentHash ?? null,
    linkCardAt: s.linkCardAt ?? null,
    schedule: s.schedule ? JSON.stringify(s.schedule) : null,
  };
  lines.push(`INSERT OR REPLACE INTO sources (${Object.keys(row).join(", ")}) VALUES (${Object.values(row).map(q).join(", ")});`);
}
const known = new Set(sources.map((s) => s._id.toHexString()));
for (const l of logs) {
  const sid = l.sourceId?.toHexString?.();
  if (!sid || !known.has(sid)) continue;
  lines.push(`INSERT INTO fetch_logs (sourceId, at, ok, durationMs, sizeBytes, error) VALUES (${[sid, l.at, !!l.ok, l.durationMs ?? 0, l.sizeBytes ?? null, l.error ?? null].map(q).join(", ")});`);
}

// The SQL holds tokens and script URLs: write it inside the git-ignored .wrangler folder, delete after.
const dir = join(ROOT, ".wrangler", "tmp");
mkdirSync(dir, { recursive: true });
const file = join(dir, `migrate-${Date.now()}.sql`);
writeFileSync(file, lines.join("\n") + "\n");
try {
  console.log(`Writing into D1 (${local ? "local" : "live"})…`);
  const wrangler = join(ROOT, "node_modules", "wrangler", "bin", "wrangler.js");
  const r = spawnSync(process.execPath, [wrangler, "d1", "execute", DATABASE, local ? "--local" : "--remote", "--file", file, "--yes"], { cwd: ROOT, stdio: "inherit" });
  if (r.status !== 0) fail("wrangler d1 execute failed (see above).");
} finally {
  rmSync(file, { force: true });
}
ok(`Done: ${sources.length} source(s) are now in D1. MongoDB was not changed.`);
