import type { Database, SourceDoc } from "./db";
import { driveEnabled } from "./drive";
import { fetchScript } from "./fetcher";
import { redact } from "./http";
import { CARD_MAX_AGE_MS, putCard } from "./linkcard";
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
export async function refreshSource(env: Env, d: Database, source: SourceDoc, timeoutMs: number): Promise<RefreshResult> {
  const drive = driveEnabled(env);
  // In Drive mode, a response identical to the last upload is not parsed or uploaded again.
  const outcome = await fetchScript(source.scriptUrl, timeoutMs, { knownHash: drive && source.driveFileId ? source.driveContentHash : null });
  const at = new Date();
  let result: RefreshResult;
  let fileId = source.driveFileId ?? null;

  if (outcome.ok) {
    try {
      let storage: RefreshResult["storage"];
      let changed = true;
      if (drive) ({ storage, changed, fileId } = await saveToDrive(env, d, source, outcome.text, outcome.sizeBytes, outcome.hash));
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

  // Rewrite the public link card only when it would otherwise be wrong (new file, error state
  // changed) or is getting old; new data in the same Drive file needs no card write.
  const cardAge = source.linkCardAt ? at.getTime() - new Date(source.linkCardAt).getTime() : Number.POSITIVE_INFINITY;
  const writeCard =
    drive && !!fileId && (fileId !== source.driveFileId || (source.lastError ?? null) !== (set.lastError ?? null) || cardAge > CARD_MAX_AGE_MS);
  if (writeCard) set.linkCardAt = at;

  await Promise.all([
    d.sources.updateOne({ _id: source._id }, { $set: set }),
    d.logs.insertOne({ sourceId: source._id, at, ok: result.ok, durationMs: result.durationMs, sizeBytes: result.sizeBytes, error: result.error }),
  ]);
  if (writeCard) await putCard(env, { ...source, ...set, driveFileId: fileId, lastFetchedAt: source.lastFetchedAt ?? at });
  if (result.ok) forgetPublic(source.token);
  console.log(
    `refresh "${source.name}": ${result.ok ? `ok, ${result.sizeBytes} bytes → ${result.storage}${result.changed === false ? " (unchanged, upload skipped)" : ""}` : `failed — ${result.error}`} (drive ${drive ? "on" : "off"}${writeCard ? ", link card updated" : ""})`,
  );
  return result;
}
