import type { Database, SourceDoc } from "./db";
import { driveEnabled } from "./drive";
import { fetchScript } from "./fetcher";
import { redact } from "./http";
import { forgetPublic } from "./public";
import { saveSnapshot, saveToDrive } from "./snapshots";

export interface RefreshResult {
  ok: boolean;
  durationMs: number;
  sizeBytes: number | null;
  error: string | null;
  storage?: "inline" | "chunked" | "drive";
  /** false when the JSON was identical to the last upload (Drive write skipped) */
  changed?: boolean;
}

/**
 * Fetches one source and records the outcome. On failure the previous snapshot is kept.
 * The caller has already set `lastFetchedAt` (the attempt time).
 */
export async function refreshSource(env: Env, d: Database, source: Pick<SourceDoc, "_id" | "scriptUrl" | "token" | "name" | "driveFileId" | "driveFolderId" | "driveContentHash">, timeoutMs: number): Promise<RefreshResult> {
  const outcome = await fetchScript(source.scriptUrl, timeoutMs);
  const at = new Date();
  let result: RefreshResult;

  if (outcome.ok) {
    try {
      let storage: RefreshResult["storage"];
      let changed = true;
      if (driveEnabled(env)) ({ storage, changed } = await saveToDrive(env, d, source, at, outcome.text, outcome.sizeBytes));
      else storage = await saveSnapshot(d, source._id, at, outcome.text, outcome.data, outcome.sizeBytes);
      result = { ok: true, durationMs: outcome.durationMs, sizeBytes: outcome.sizeBytes, error: null, storage, changed };
    } catch (err) {
      result = { ok: false, durationMs: outcome.durationMs, sizeBytes: outcome.sizeBytes, error: `Could not save the data: ${redact(String((err as Error)?.message ?? err), env)}` };
    }
  } else {
    result = { ok: false, durationMs: outcome.durationMs, sizeBytes: outcome.sizeBytes, error: outcome.error };
  }

  const set: Partial<SourceDoc> = result.ok
    ? { lastSuccessAt: at, lastError: null, lastDurationMs: result.durationMs, lastSizeBytes: result.sizeBytes }
    : { lastError: result.error, lastDurationMs: result.durationMs };
  await Promise.all([
    d.sources.updateOne({ _id: source._id }, { $set: set }),
    d.logs.insertOne({ sourceId: source._id, at, ok: result.ok, durationMs: result.durationMs, sizeBytes: result.sizeBytes, error: result.error }),
  ]);
  if (result.ok) forgetPublic(source.token);
  console.log(`refresh "${source.name}": ${result.ok ? `ok, ${result.sizeBytes} bytes → ${result.storage}${result.changed === false ? " (unchanged, upload skipped)" : ""}` : `failed — ${result.error}`} (drive ${driveEnabled(env) ? "on" : "off"})`);
  return result;
}
