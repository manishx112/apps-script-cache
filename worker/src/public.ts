// GET /d/:token, /d/:token?format=csv and /d/:token/meta — public, read-only, cached.
//
// Two cache layers keep dashboards away from MongoDB:
//  1. caches.default (Cloudflare edge cache; active on custom domains — a no-op on *.workers.dev)
//  2. a small in-memory map in the running isolate (helps everywhere, including workers.dev)

import { type Database, TOKEN_RE, withDb } from "./db";
import { errorJson, HttpError, intVar, redact } from "./http";
import { toCsv } from "./shape";
import { driveEnabled } from "./drive";
import { loadFromDrive, loadSnapshot } from "./snapshots";

interface Cached {
  status: number;
  body: string;
  contentType: string;
  fetchedAt: string | null;
  expires: number;
  extra?: Record<string, string>;
}

const memory = new Map<string, Cached>();
const MEMORY_MAX_ENTRIES = 200;
const MEMORY_MAX_BODY = 2_000_000;

const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, HEAD, OPTIONS",
  "access-control-allow-headers": "*",
  "access-control-expose-headers": "X-Cache-Fetched-At, X-Cache-Age-Seconds, X-Cache-Layer",
};

type Variant = "json" | "csv" | "meta";
const VARIANTS: Variant[] = ["json", "csv", "meta"];

function cacheUrl(origin: string, token: string, variant: Variant): string {
  return `${origin}/d/${token}/__cache/${variant}`;
}

/** Drops a token's entries from this isolate's memory cache (after a refresh / rotate / delete). */
export function forgetPublic(token: string): void {
  for (const v of VARIANTS) memory.delete(`${token}:${v}`);
}

/** Also purges the edge cache for this colo. Other colos expire within the TTL. */
export function purgePublic(origin: string, token: string, ctx: ExecutionContext): void {
  forgetPublic(token);
  ctx.waitUntil(Promise.all(VARIANTS.map((v) => caches.default.delete(cacheUrl(origin, token, v)))).catch(() => {}));
}

function respond(c: Cached, layer: string, method: string): Response {
  const headers = new Headers({ ...CORS, ...c.extra, "content-type": c.contentType, "x-cache-layer": layer });
  if (c.fetchedAt) {
    headers.set("x-cache-fetched-at", c.fetchedAt);
    headers.set("x-cache-age-seconds", String(Math.max(0, Math.round((Date.now() - Date.parse(c.fetchedAt)) / 1000))));
  }
  const ttl = Math.max(0, Math.round((c.expires - Date.now()) / 1000));
  headers.set("cache-control", c.status === 200 ? `public, max-age=${ttl}` : "no-store");
  return new Response(method === "HEAD" ? null : c.body, { status: c.status, headers });
}

export async function handlePublic(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...CORS, "access-control-max-age": "86400" } });
  if (req.method !== "GET" && req.method !== "HEAD") return errorJson(405, "Method not allowed.", CORS);

  const url = new URL(req.url);
  const m = /^\/d\/([^/]+)(\/meta)?\/?$/.exec(url.pathname);
  if (!m || !TOKEN_RE.test(m[1])) return errorJson(404, "Unknown link.", CORS);
  const token = m[1];
  const format = url.searchParams.get("format")?.toLowerCase();
  if (!m[2] && format && format !== "json" && format !== "csv") return errorJson(400, "format must be json or csv.", CORS);
  const variant: Variant = m[2] ? "meta" : format === "csv" ? "csv" : "json";
  const ttlMs = intVar(env.PUBLIC_CACHE_TTL_SECONDS, 60) * 1000;

  // Layer 2: memory
  const memKey = `${token}:${variant}`;
  const hit = memory.get(memKey);
  if (hit && hit.expires > Date.now()) return respond(hit, "memory", req.method);

  // Layer 1: edge cache
  const edgeKey = cacheUrl(url.origin, token, variant);
  const edge = await caches.default.match(edgeKey);
  if (edge) {
    const c: Cached = {
      status: edge.status,
      body: await edge.text(),
      contentType: edge.headers.get("content-type") ?? "application/json",
      fetchedAt: edge.headers.get("x-cache-fetched-at"),
      expires: Number(edge.headers.get("x-cache-expires")) || Date.now() + ttlMs,
      extra: edge.headers.get("content-disposition") ? { "content-disposition": edge.headers.get("content-disposition")! } : undefined,
    };
    remember(memKey, c);
    return respond(c, "edge", req.method);
  }

  // Miss: read MongoDB
  let c: Cached;
  try {
    c = await withDb(env, ctx, (d) => build(env, d, url.origin, token, variant, ttlMs));
  } catch (err) {
    if (err instanceof HttpError) {
      c = { status: err.status, body: JSON.stringify({ error: err.message }), contentType: "application/json; charset=utf-8", fetchedAt: null, expires: Date.now() + (err.status === 404 ? ttlMs : 10_000) };
    } else {
      console.error("public read failed:", redact(String((err as Error)?.stack ?? err), env));
      return errorJson(503, "Cache temporarily unavailable, try again shortly.", CORS);
    }
  }
  remember(memKey, c);
  const stored = new Response(c.body, {
    status: c.status,
    headers: { ...c.extra, "content-type": c.contentType, "cache-control": `public, max-age=${Math.round((c.expires - Date.now()) / 1000)}`, "x-cache-fetched-at": c.fetchedAt ?? "", "x-cache-expires": String(c.expires) },
  });
  ctx.waitUntil(caches.default.put(edgeKey, stored).catch(() => {}));
  return respond(c, "miss", req.method);
}

function remember(key: string, c: Cached): void {
  if (c.body.length > MEMORY_MAX_BODY) return;
  if (memory.size >= MEMORY_MAX_ENTRIES) memory.delete(memory.keys().next().value!);
  memory.set(key, c);
}

async function build(env: Env, d: Database, origin: string, token: string, variant: Variant, ttlMs: number): Promise<Cached> {
  const source = await d.sources.findOne({ token });
  if (!source) throw new HttpError(404, "Unknown link.");
  const expires = Date.now() + ttlMs;

  if (variant === "meta") {
    const meta = {
      name: source.name,
      status: source.status,
      intervalMin: source.intervalMin,
      lastFetchedAt: source.lastFetchedAt,
      lastSuccessAt: source.lastSuccessAt,
      lastError: source.lastError,
      lastDurationMs: source.lastDurationMs,
      sizeBytes: source.lastSizeBytes,
      dataUrl: `${origin}/d/${token}`,
      csvUrl: `${origin}/d/${token}?format=csv`,
    };
    return { status: 200, body: JSON.stringify(meta, null, 2), contentType: "application/json; charset=utf-8", fetchedAt: source.lastSuccessAt?.toISOString() ?? null, expires };
  }

  const snap = source.driveFileId && driveEnabled(env) ? await loadFromDrive(env, d, source) : await loadSnapshot(env, d, source._id);
  if (!snap) throw new HttpError(503, source.lastError ? `No data yet — last fetch failed: ${source.lastError}` : "No data yet — the first fetch has not finished. Try again in a minute.");
  const fetchedAt = snap.fetchedAt.toISOString();
  if (variant === "csv") {
    const filename = `${source.name.replace(/[^A-Za-z0-9 _-]+/g, "").trim().replace(/\s+/g, "-") || "data"}.csv`;
    return { status: 200, body: toCsv(snap.data()), contentType: "text/csv; charset=utf-8", fetchedAt, expires, extra: { "content-disposition": `inline; filename="${filename}"` } };
  }
  return { status: 200, body: snap.text, contentType: "application/json; charset=utf-8", fetchedAt, expires };
}
