// Cloudflare D1 (SQLite) storage: sources, their latest snapshot (only when Google Drive is off)
// and fetch logs. D1 is a binding, not a network database: no connection, no driver, ~1 ms per query.

import type { Schedule } from "./schedule";
import SCHEMA_SQL from "./schema.sql";

export const INTERVALS = [5, 10, 15, 30, 60] as const;
export type SourceStatus = "active" | "paused";

export interface SourceDoc {
  /** 24 hex chars (the same ids the sources had in MongoDB). */
  id: string;
  name: string;
  scriptUrl: string;
  intervalMin: number;
  token: string;
  status: SourceStatus;
  lastFetchedAt: Date | null;
  lastSuccessAt: Date | null;
  lastError: string | null;
  lastDurationMs: number | null;
  lastSizeBytes: number | null;
  createdAt: Date;
  /** Google Drive file holding the latest JSON (Drive mode only). */
  driveFileId?: string | null;
  /** Google Drive folder for this source (inside the root "Apps Script Cache" folder). */
  driveFolderId?: string | null;
  /** SHA-256 of the last uploaded JSON; an identical response skips the upload. */
  driveContentHash?: string | null;
  /** When this source's KV link card was last written (see linkcard.ts). */
  linkCardAt?: Date | null;
  /** Refresh only on these days/hours; null or missing = around the clock. */
  schedule?: Schedule | null;
}

export interface FetchLog {
  at: Date;
  ok: boolean;
  durationMs: number;
  sizeBytes: number | null;
  error: string | null;
}

export const LOG_RETENTION_MS = 7 * 24 * 3600_000;

// Statements of schema.sql (imported as text, see [[rules]] in wrangler.toml).
const SCHEMA = SCHEMA_SQL.replace(/--.*$/gm, "")
  .split(";")
  .map((sql) => sql.trim())
  .filter(Boolean);

let schemaReady: Promise<void> | null = null;

/** Creates the tables once per Worker instance (cheap no-op when they exist). */
export function db(env: Env): Promise<D1Database> {
  schemaReady ??= env.DB.batch(SCHEMA.map((sql) => env.DB.prepare(sql)))
    .then(() => undefined)
    .catch((err) => {
      schemaReady = null;
      throw err;
    });
  return schemaReady.then(() => env.DB);
}

// --- row <-> object ---------------------------------------------------------------------------

type Row = Record<string, unknown>;
const toDate = (v: unknown) => (v === null || v === undefined ? null : new Date(Number(v)));
const toMs = (v: Date | null | undefined) => (v ? new Date(v).getTime() : null);

const DATE_FIELDS = new Set(["lastFetchedAt", "lastSuccessAt", "createdAt", "linkCardAt"]);
const COLUMNS = [
  "id", "name", "scriptUrl", "intervalMin", "token", "status", "lastFetchedAt", "lastSuccessAt", "lastError",
  "lastDurationMs", "lastSizeBytes", "createdAt", "driveFileId", "driveFolderId", "driveContentHash", "linkCardAt", "schedule",
] as const;

function fromRow(r: Row): SourceDoc {
  return {
    id: String(r.id),
    name: String(r.name),
    scriptUrl: String(r.scriptUrl),
    intervalMin: Number(r.intervalMin),
    token: String(r.token),
    status: r.status === "paused" ? "paused" : "active",
    lastFetchedAt: toDate(r.lastFetchedAt),
    lastSuccessAt: toDate(r.lastSuccessAt),
    lastError: (r.lastError as string | null) ?? null,
    lastDurationMs: (r.lastDurationMs as number | null) ?? null,
    lastSizeBytes: (r.lastSizeBytes as number | null) ?? null,
    createdAt: toDate(r.createdAt) ?? new Date(0),
    driveFileId: (r.driveFileId as string | null) ?? null,
    driveFolderId: (r.driveFolderId as string | null) ?? null,
    driveContentHash: (r.driveContentHash as string | null) ?? null,
    linkCardAt: toDate(r.linkCardAt),
    schedule: r.schedule ? (JSON.parse(String(r.schedule)) as Schedule) : null,
  };
}

function toColumn(field: string, value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (DATE_FIELDS.has(field)) return toMs(value as Date);
  if (field === "schedule") return JSON.stringify(value);
  return value;
}

// --- sources ----------------------------------------------------------------------------------

export async function listSources(env: Env, onlyActive = false): Promise<SourceDoc[]> {
  const d = await db(env);
  const sql = onlyActive
    ? "SELECT * FROM sources WHERE status = 'active' ORDER BY lastFetchedAt"
    : "SELECT * FROM sources ORDER BY createdAt DESC";
  const { results } = await d.prepare(sql).all<Row>();
  return results.map(fromRow);
}

export async function findSource(env: Env, id: string): Promise<SourceDoc | null> {
  const row = await (await db(env)).prepare("SELECT * FROM sources WHERE id = ?").bind(id).first<Row>();
  return row ? fromRow(row) : null;
}

export async function findSourceByToken(env: Env, token: string): Promise<SourceDoc | null> {
  const row = await (await db(env)).prepare("SELECT * FROM sources WHERE token = ?").bind(token).first<Row>();
  return row ? fromRow(row) : null;
}

export async function insertSource(env: Env, s: SourceDoc): Promise<void> {
  const d = await db(env);
  await d
    .prepare(`INSERT INTO sources (${COLUMNS.join(", ")}) VALUES (${COLUMNS.map(() => "?").join(", ")})`)
    .bind(...COLUMNS.map((c) => toColumn(c, s[c])))
    .run();
}

/** Sets the given fields; `null` clears one. Returns the updated source, or null if it does not exist. */
export async function updateSource(env: Env, id: string, set: Partial<Omit<SourceDoc, "id">>): Promise<SourceDoc | null> {
  const fields = Object.keys(set).filter((k) => (COLUMNS as readonly string[]).includes(k) && k !== "id");
  const d = await db(env);
  if (!fields.length) return findSource(env, id);
  const row = await d
    .prepare(`UPDATE sources SET ${fields.map((f) => `${f} = ?`).join(", ")} WHERE id = ? RETURNING *`)
    .bind(...fields.map((f) => toColumn(f, set[f as keyof typeof set])), id)
    .first<Row>();
  return row ? fromRow(row) : null;
}

/**
 * Marks a source as being fetched now, but only if nobody else did since it was read
 * (so an overlapping cron run does not fetch it twice).
 */
export async function claimSource(env: Env, s: SourceDoc, now: Date): Promise<boolean> {
  const d = await db(env);
  const r = await d
    .prepare("UPDATE sources SET lastFetchedAt = ? WHERE id = ? AND lastFetchedAt IS ?")
    .bind(now.getTime(), s.id, toMs(s.lastFetchedAt))
    .run();
  return r.meta.changes === 1;
}

/** Deletes a source and everything stored for it. */
export async function deleteSource(env: Env, id: string): Promise<void> {
  const d = await db(env);
  await d.batch([
    d.prepare("DELETE FROM sources WHERE id = ?").bind(id),
    d.prepare("DELETE FROM snapshots WHERE sourceId = ?").bind(id),
    d.prepare("DELETE FROM snapshot_chunks WHERE sourceId = ?").bind(id),
    d.prepare("DELETE FROM fetch_logs WHERE sourceId = ?").bind(id),
  ]);
}

// --- fetch logs -------------------------------------------------------------------------------

export async function insertLog(env: Env, sourceId: string, log: FetchLog): Promise<void> {
  const d = await db(env);
  await d
    .prepare("INSERT INTO fetch_logs (sourceId, at, ok, durationMs, sizeBytes, error) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(sourceId, log.at.getTime(), log.ok ? 1 : 0, log.durationMs, log.sizeBytes, log.error)
    .run();
}

export async function listLogs(env: Env, sourceId: string, limit = 50): Promise<FetchLog[]> {
  const d = await db(env);
  const { results } = await d
    .prepare("SELECT at, ok, durationMs, sizeBytes, error FROM fetch_logs WHERE sourceId = ? ORDER BY at DESC LIMIT ?")
    .bind(sourceId, limit)
    .all<Row>();
  return results.map((r) => ({ at: new Date(Number(r.at)), ok: !!r.ok, durationMs: Number(r.durationMs), sizeBytes: (r.sizeBytes as number | null) ?? null, error: (r.error as string | null) ?? null }));
}

/** Logs are kept for 7 days (MongoDB did this with a TTL index; SQLite needs a delete). */
export async function pruneLogs(env: Env, now = Date.now()): Promise<number> {
  const d = await db(env);
  const r = await d.prepare("DELETE FROM fetch_logs WHERE at < ?").bind(now - LOG_RETENTION_MS).run();
  return r.meta.changes;
}

// --- ids / tokens -----------------------------------------------------------------------------

export function newId(): string {
  return [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export const ID_RE = /^[0-9a-f]{24}$/i;

export function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export const TOKEN_RE = /^[A-Za-z0-9_-]{32,64}$/;
