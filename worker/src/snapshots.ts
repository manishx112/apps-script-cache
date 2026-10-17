import { db, type SourceDoc, updateSource } from "./db";
import { createFolder, DriveNotFound, folderName, jsonFileName, moveItem, readJsonFile, writeJsonFile } from "./drive";

// Without Google Drive the JSON text is kept in D1, split into chunks: a D1 row may hold at most
// 2 MB, and 500k characters stay under that even if every character takes 4 bytes in UTF-8.
const CHUNK_CHARS = 500_000;

export async function saveSnapshot(env: Env, sourceId: string, fetchedAt: Date, text: string, sizeBytes: number): Promise<"d1"> {
  const d = await db(env);
  const version = crypto.randomUUID();
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += CHUNK_CHARS) chunks.push(text.slice(i, i + CHUNK_CHARS));
  // One transaction: the new chunks, the pointer to them, and removal of the old version.
  await d.batch([
    ...chunks.map((t, n) => d.prepare("INSERT INTO snapshot_chunks (sourceId, version, n, text) VALUES (?, ?, ?, ?)").bind(sourceId, version, n, t)),
    d
      .prepare("INSERT OR REPLACE INTO snapshots (sourceId, fetchedAt, sizeBytes, chunkVersion, chunkCount) VALUES (?, ?, ?, ?, ?)")
      .bind(sourceId, fetchedAt.getTime(), sizeBytes, version, chunks.length),
    d.prepare("DELETE FROM snapshot_chunks WHERE sourceId = ? AND version <> ?").bind(sourceId, version),
  ]);
  return "d1";
}

/**
 * Google Drive mode. Layout: <root>/<source name>/<source name>.json — one folder and one file per
 * source; every refresh overwrites that same file (same file id), so old copies never pile up.
 * If the JSON is byte-for-byte unchanged since the last upload, the upload is skipped.
 */
export async function saveToDrive(
  env: Env,
  source: Pick<SourceDoc, "id" | "name" | "driveFileId" | "driveFolderId" | "driveContentHash">,
  text: string,
  sizeBytes: number,
  hash: string,
): Promise<{ storage: "drive"; changed: boolean; fileId: string }> {
  const root = env.GOOGLE_DRIVE_FOLDER_ID!.trim();
  const set: Partial<SourceDoc> = {};
  let folderId = source.driveFolderId ?? null;
  let fileId = source.driveFileId ?? null;

  if (!folderId) {
    folderId = await createFolder(env, folderName(source.name), root);
    set.driveFolderId = folderId;
    // Sources saved before per-source folders existed: move their file into the new folder.
    if (fileId) {
      try {
        await moveItem(env, fileId, folderId, root);
      } catch (err) {
        if (!(err instanceof DriveNotFound)) throw err;
        fileId = null;
      }
    }
  }

  const changed = !fileId || hash !== source.driveContentHash;
  if (changed) {
    const write = (folder: string, existing: string | null) => writeJsonFile(env, { fileId: existing, folderId: folder, name: jsonFileName(source.name), text, sizeBytes });
    try {
      fileId = await write(folderId, fileId);
    } catch (err) {
      if (!(err instanceof DriveNotFound)) throw err;
      // The source's folder was deleted in Drive: recreate it.
      folderId = await createFolder(env, folderName(source.name), root);
      set.driveFolderId = folderId;
      fileId = await write(folderId, null);
    }
    set.driveContentHash = hash;
  }
  if (fileId !== source.driveFileId) set.driveFileId = fileId;
  if (Object.keys(set).length) await updateSource(env, source.id, set);
  return { storage: "drive", changed, fileId: fileId! };
}

export interface LoadedSnapshot {
  fetchedAt: Date;
  sizeBytes: number;
  /** JSON text exactly as served. */
  text: string;
  /** Parsed value (parsed lazily; only needed for CSV). */
  data(): unknown;
}

function loaded(fetchedAt: Date, sizeBytes: number, text: string): LoadedSnapshot {
  let parsed: unknown;
  return { fetchedAt, sizeBytes, text, data: () => (parsed ??= JSON.parse(text)) };
}

/** Reads a Drive-mode source's JSON straight from Drive, using only fields of the source. */
export async function loadFromDrive(env: Env, source: Pick<SourceDoc, "id" | "driveFileId" | "lastSuccessAt" | "lastSizeBytes">): Promise<LoadedSnapshot> {
  let text: string;
  try {
    text = await readJsonFile(env, source.driveFileId!);
  } catch (err) {
    // File deleted in Drive: forget the hash so the next refresh uploads it again.
    if (err instanceof DriveNotFound) await updateSource(env, source.id, { driveContentHash: null });
    throw err;
  }
  return loaded(source.lastSuccessAt ?? new Date(), source.lastSizeBytes ?? text.length, text);
}

/** Reads a snapshot stored in D1 (Drive off). */
export async function loadSnapshot(env: Env, sourceId: string): Promise<LoadedSnapshot | null> {
  const d = await db(env);
  const snap = await d.prepare("SELECT * FROM snapshots WHERE sourceId = ?").bind(sourceId).first<{ fetchedAt: number; sizeBytes: number; chunkVersion: string; chunkCount: number }>();
  if (!snap) return null;
  const { results } = await d
    .prepare("SELECT text FROM snapshot_chunks WHERE sourceId = ? AND version = ? ORDER BY n")
    .bind(sourceId, snap.chunkVersion)
    .all<{ text: string }>();
  if (results.length !== snap.chunkCount) throw new Error("Snapshot is incomplete (chunks missing); it will be rewritten on the next fetch.");
  return loaded(new Date(snap.fetchedAt), snap.sizeBytes, results.map((p) => p.text).join(""));
}

/** Drive mode keeps no copy in D1; removes one left from before Drive was turned on. */
export async function dropSnapshot(env: Env, sourceId: string): Promise<void> {
  const d = await db(env);
  await d.batch([d.prepare("DELETE FROM snapshots WHERE sourceId = ?").bind(sourceId), d.prepare("DELETE FROM snapshot_chunks WHERE sourceId = ?").bind(sourceId)]);
}
