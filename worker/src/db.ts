import { type Collection, type Db, MongoClient, ObjectId } from "mongodb";
import type { Schedule } from "./schedule";

export const DB_NAME = "cache_proxy";
export const INTERVALS = [5, 10, 15, 30, 60] as const;
export type SourceStatus = "active" | "paused";

export interface SourceDoc {
  _id: ObjectId;
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

/** Latest response per source: parsed in `data` (inline), as text chunks (chunked), or as a Google Drive file (drive). */
export interface SnapshotDoc {
  sourceId: ObjectId;
  fetchedAt: Date;
  sizeBytes: number;
  storage: "inline" | "chunked" | "drive";
  data?: unknown;
  chunkVersion?: string;
  chunkCount?: number;
  driveFileId?: string;
}

export interface ChunkDoc {
  sourceId: ObjectId;
  version: string;
  n: number;
  text: string;
}

export interface FetchLogDoc {
  sourceId: ObjectId;
  at: Date;
  ok: boolean;
  durationMs: number;
  sizeBytes: number | null;
  error: string | null;
}

export interface Database {
  db: Db;
  sources: Collection<SourceDoc>;
  snapshots: Collection<SnapshotDoc>;
  chunks: Collection<ChunkDoc>;
  logs: Collection<FetchLogDoc>;
  close(): Promise<void>;
}

export async function openDb(env: Env): Promise<Database> {
  if (!env.MONGODB_URI) throw new Error("MONGODB_URI secret is not set.");
  // A Worker invocation may hold at most 6 connections and sockets cannot be reused across
  // requests, so each invocation gets its own small client: 3 replica-set monitors + 1–2 pool sockets.
  const client = new MongoClient(env.MONGODB_URI.trim(), {
    appName: "apps-script-cache",
    maxPoolSize: 2,
    minPoolSize: 0,
    serverMonitoringMode: "poll",
    serverSelectionTimeoutMS: 10_000,
    connectTimeoutMS: 10_000,
    socketTimeoutMS: 30_000,
  });
  await client.connect();
  const db = client.db(DB_NAME);
  return {
    db,
    sources: db.collection<SourceDoc>("sources"),
    snapshots: db.collection<SnapshotDoc>("snapshots"),
    chunks: db.collection<ChunkDoc>("snapshot_chunks"),
    logs: db.collection<FetchLogDoc>("fetch_logs"),
    close: () => client.close(),
  };
}

/**
 * Opens a client, runs `fn`, then closes the client — after the response when `ctx` is given,
 * so closing does not add latency.
 */
export async function withDb<T>(env: Env, ctx: ExecutionContext | null, fn: (d: Database) => Promise<T>): Promise<T> {
  const d = await openDb(env);
  try {
    return await fn(d);
  } finally {
    const closing = d.close().catch(() => {});
    if (ctx) ctx.waitUntil(closing);
    else await closing;
  }
}

let indexesReady = false;

export async function ensureIndexes(d: Database): Promise<void> {
  if (indexesReady) return;
  await Promise.all([
    d.sources.createIndexes([
      { key: { token: 1 }, name: "token_unique", unique: true },
      { key: { status: 1, lastFetchedAt: 1 }, name: "status_lastFetchedAt" },
    ]),
    d.snapshots.createIndex({ sourceId: 1 }, { name: "sourceId_unique", unique: true }),
    d.chunks.createIndex({ sourceId: 1, version: 1, n: 1 }, { name: "source_version_n" }),
    d.logs.createIndexes([
      { key: { at: 1 }, name: "ttl_7_days", expireAfterSeconds: 7 * 24 * 3600 },
      { key: { sourceId: 1, at: -1 }, name: "source_at" },
    ]),
  ]);
  indexesReady = true;
}

export function newToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export const TOKEN_RE = /^[A-Za-z0-9_-]{32,64}$/;

export function parseObjectId(id: string): ObjectId | null {
  return /^[0-9a-f]{24}$/i.test(id) ? new ObjectId(id) : null;
}
