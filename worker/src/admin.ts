// /api/* — admin API (session cookie required, except login/logout/session).

import { ObjectId } from "mongodb";
import { checkOrigin, isAuthenticated, login, logout } from "./auth";
import { type Database, ensureIndexes, INTERVALS, newToken, openDb, parseObjectId, type SourceDoc, withDb } from "./db";
import { fetchScript, isScriptUrl } from "./fetcher";
import { errorJson, HttpError, intVar, json, readJson } from "./http";
import { purgePublic } from "./public";
import { refreshSource } from "./refresh";
import { resetSchedulerMemo } from "./scheduler";
import { buildPreview } from "./shape";

const LARGE_RESPONSE_BYTES = 5 * 1024 * 1024;

function serialize(s: SourceDoc) {
  const health = s.status === "paused" ? "paused" : s.lastError ? "error" : s.lastSuccessAt ? "ok" : "pending";
  return {
    id: s._id.toHexString(),
    name: s.name,
    scriptUrl: s.scriptUrl,
    intervalMin: s.intervalMin,
    token: s.token,
    status: s.status,
    health,
    lastFetchedAt: s.lastFetchedAt,
    lastSuccessAt: s.lastSuccessAt,
    lastError: s.lastError,
    lastDurationMs: s.lastDurationMs,
    lastSizeBytes: s.lastSizeBytes,
    createdAt: s.createdAt,
  };
}

function validName(v: unknown): string {
  const name = typeof v === "string" ? v.trim() : "";
  if (!name || name.length > 100) throw new HttpError(400, "Name is required (max 100 characters).");
  return name;
}

function validUrl(v: unknown): string {
  if (!isScriptUrl(v)) throw new HttpError(400, "URL must look like https://script.google.com/macros/s/<id>/exec");
  return v.trim();
}

function validInterval(v: unknown): number {
  const n = Number(v);
  if (!(INTERVALS as readonly number[]).includes(n)) throw new HttpError(400, `Interval must be one of ${INTERVALS.join(", ")} minutes.`);
  return n;
}

async function getSource(d: Database, id: ObjectId): Promise<SourceDoc> {
  const s = await d.sources.findOne({ _id: id });
  if (!s) throw new HttpError(404, "Source not found.");
  return s;
}

export async function handleApi(req: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "");
  const method = req.method;
  checkOrigin(req);

  if (path === "/api/login" && method === "POST") return login(req, env);
  if (path === "/api/logout" && method === "POST") return logout(req);
  if (path === "/api/session" && method === "GET") return json({ authenticated: await isAuthenticated(req, env) });

  if (!(await isAuthenticated(req, env))) return errorJson(401, "Please sign in.");
  const timeoutMs = intVar(env.FETCH_TIMEOUT_MS, 25_000);

  // POST /api/sources/test — fetch once, nothing saved, no database needed.
  if (path === "/api/sources/test" && method === "POST") {
    const body = await readJson(req);
    const scriptUrl = validUrl(body.scriptUrl);
    const r = await fetchScript(scriptUrl, timeoutMs);
    if (!r.ok) return json({ ok: false, durationMs: r.durationMs, sizeBytes: r.sizeBytes, error: r.error });
    return json({ ok: true, durationMs: r.durationMs, sizeBytes: r.sizeBytes, large: r.sizeBytes > LARGE_RESPONSE_BYTES, preview: buildPreview(r.data) });
  }

  if (path === "/api/sources" && method === "GET") {
    return withDb(env, ctx, async (d) => {
      const list = await d.sources.find({}, { sort: { createdAt: -1 } }).toArray();
      return json({ sources: list.map(serialize) });
    });
  }

  if (path === "/api/sources" && method === "POST") {
    const body = await readJson(req);
    const doc: Omit<SourceDoc, "_id"> = {
      name: validName(body.name),
      scriptUrl: validUrl(body.scriptUrl),
      intervalMin: validInterval(body.intervalMin),
      token: newToken(),
      status: "active",
      lastFetchedAt: new Date(),
      lastSuccessAt: null,
      lastError: null,
      lastDurationMs: null,
      lastSizeBytes: null,
      createdAt: new Date(),
    };
    // First fetch runs right away, after the response is sent, so the link has data within seconds.
    const d = await openDb(env);
    try {
      await ensureIndexes(d);
      const created: SourceDoc = { ...doc, _id: new ObjectId() };
      await d.sources.insertOne(created);
      ctx.waitUntil(refreshSource(env, d, created, timeoutMs).catch((e) => console.error("first fetch failed", String(e))).finally(() => d.close().catch(() => {})));
      resetSchedulerMemo();
      return json({ source: serialize(created) }, { status: 201 });
    } catch (err) {
      ctx.waitUntil(d.close().catch(() => {}));
      throw err;
    }
  }

  const m = /^\/api\/sources\/([^/]+)(?:\/(refresh|rotate-token|logs))?$/.exec(path);
  if (!m) return errorJson(404, "Not found.");
  const id = parseObjectId(m[1]);
  if (!id) return errorJson(404, "Source not found.");
  const action = m[2];

  if (!action && method === "GET") {
    return withDb(env, ctx, async (d) => json({ source: serialize(await getSource(d, id)) }));
  }

  if (!action && method === "PATCH") {
    const body = await readJson(req);
    const set: Partial<SourceDoc> = {};
    if ("name" in body) set.name = validName(body.name);
    if ("scriptUrl" in body) set.scriptUrl = validUrl(body.scriptUrl);
    if ("intervalMin" in body) set.intervalMin = validInterval(body.intervalMin);
    if ("status" in body) {
      if (body.status !== "active" && body.status !== "paused") throw new HttpError(400, "status must be active or paused.");
      set.status = body.status;
    }
    if (!Object.keys(set).length) throw new HttpError(400, "Nothing to update.");
    return withDb(env, ctx, async (d) => {
      const updated = await d.sources.findOneAndUpdate({ _id: id }, { $set: set }, { returnDocument: "after" });
      if (!updated) throw new HttpError(404, "Source not found.");
      resetSchedulerMemo();
      return json({ source: serialize(updated) });
    });
  }

  if (!action && method === "DELETE") {
    return withDb(env, ctx, async (d) => {
      const s = await getSource(d, id);
      await Promise.all([d.sources.deleteOne({ _id: id }), d.snapshots.deleteOne({ sourceId: id }), d.chunks.deleteMany({ sourceId: id }), d.logs.deleteMany({ sourceId: id })]);
      purgePublic(url.origin, s.token, ctx);
      return json({ ok: true });
    });
  }

  if (action === "refresh" && method === "POST") {
    return withDb(env, ctx, async (d) => {
      const s = await getSource(d, id);
      await d.sources.updateOne({ _id: id }, { $set: { lastFetchedAt: new Date() } });
      const result = await refreshSource(env, d, s, timeoutMs);
      if (result.ok) purgePublic(url.origin, s.token, ctx);
      return json({ result, source: serialize(await getSource(d, id)) });
    });
  }

  if (action === "rotate-token" && method === "POST") {
    return withDb(env, ctx, async (d) => {
      const s = await getSource(d, id);
      const updated = await d.sources.findOneAndUpdate({ _id: id }, { $set: { token: newToken() } }, { returnDocument: "after" });
      purgePublic(url.origin, s.token, ctx);
      return json({ source: serialize(updated!) });
    });
  }

  if (action === "logs" && method === "GET") {
    return withDb(env, ctx, async (d) => {
      const logs = await d.logs.find({ sourceId: id }, { sort: { at: -1 }, limit: 50 }).toArray();
      return json({ logs: logs.map((l) => ({ at: l.at, ok: l.ok, durationMs: l.durationMs, sizeBytes: l.sizeBytes, error: l.error })) });
    });
  }

  return errorJson(405, "Method not allowed.");
}
