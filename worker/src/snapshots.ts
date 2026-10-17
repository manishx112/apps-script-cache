import { BSON, type ObjectId } from "mongodb";
import type { Database, SnapshotDoc, SourceDoc } from "./db";
import { createFolder, DriveNotFound, folderName, jsonFileName, moveItem, readJsonFile, writeJsonFile } from "./drive";

// MongoDB documents max out at 16 MB of BSON. BSON can be several times larger than the JSON text
// (array indexes become keys), so: small responses are always stored parsed; larger ones are measured;
// anything that would not fit is stored as raw JSON text split over `snapshot_chunks`.
const ALWAYS_INLINE_BYTES = 1_500_000;
const MAX_INLINE_BSON_BYTES = 15_500_000;
const CHUNK_CHARS = 3_000_000; // ≤ 12 MB of UTF-8 even if every char is 4 bytes

export async function saveSnapshot(d: Database, sourceId: ObjectId, fetchedAt: Date, text: string, data: unknown, sizeBytes: number): Promise<"inline" | "chunked"> {
  const inline = sizeBytes <= ALWAYS_INLINE_BYTES || BSON.calculateObjectSize({ data }) <= MAX_INLINE_BSON_BYTES;

  if (inline) {
    const before = await d.snapshots.findOneAndReplace(
      { sourceId },
      { sourceId, fetchedAt, sizeBytes, storage: "inline", data },
      { upsert: true, projection: { storage: 1 }, returnDocument: "before" },
    );
    if (before?.storage === "chunked") await d.chunks.deleteMany({ sourceId });
    return "inline";
  }

  // Write the new chunks first, then point the snapshot at them, then drop the old version:
  // readers always see one complete version.
  const version = crypto.randomUUID();
  const docs = [];
  for (let i = 0, n = 0; i < text.length; i += CHUNK_CHARS, n++) docs.push({ sourceId, version, n, text: text.slice(i, i + CHUNK_CHARS) });
  await d.chunks.insertMany(docs, { ordered: true });
  await d.snapshots.replaceOne(
    { sourceId },
    { sourceId, fetchedAt, sizeBytes, storage: "chunked", chunkVersion: version, chunkCount: docs.length },
    { upsert: true },
  );
  await d.chunks.deleteMany({ sourceId, version: { $ne: version } });
  return "chunked";
}

/**
 * Google Drive mode. Layout: <root>/<source name>/<source name>.json — one folder and one file per
 * source; every refresh overwrites that same file (same file id), so old copies never pile up.
 * If the JSON is byte-for-byte unchanged since the last upload, the upload is skipped.
 */
export async function saveToDrive(
  env: Env,
  d: Database,
  source: Pick<SourceDoc, "_id" | "name" | "driveFileId" | "driveFolderId" | "driveContentHash">,
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
  if (Object.keys(set).length) await d.sources.updateOne({ _id: source._id }, { $set: set });

  // In Drive mode the source document alone describes the data (driveFileId, lastSuccessAt,
  // lastSizeBytes), so any snapshot copy left in MongoDB from before is redundant — remove it.
  const old = await d.snapshots.findOneAndDelete({ sourceId: source._id }, { projection: { storage: 1 } });
  if (old?.storage === "chunked") await d.chunks.deleteMany({ sourceId: source._id });
  return { storage: "drive", changed, fileId: fileId! };
}

/** Reads a Drive-mode source's JSON straight from Drive, using only fields of the source document. */
export async function loadFromDrive(env: Env, d: Database, source: Pick<SourceDoc, "_id" | "driveFileId" | "lastSuccessAt" | "lastSizeBytes">): Promise<LoadedSnapshot> {
  let text: string;
  try {
    text = await readJsonFile(env, source.driveFileId!);
  } catch (err) {
    // File deleted in Drive: forget the hash so the next refresh uploads it again.
    if (err instanceof DriveNotFound) await d.sources.updateOne({ _id: source._id }, { $unset: { driveContentHash: 1 } });
    throw err;
  }
  let parsed: unknown;
  return { fetchedAt: source.lastSuccessAt ?? new Date(), sizeBytes: source.lastSizeBytes ?? text.length, text, data: () => (parsed ??= JSON.parse(text)) };
}


export interface LoadedSnapshot {
  fetchedAt: Date;
  sizeBytes: number;
  /** JSON text exactly as served. */
  text: string;
  /** Parsed value (parsed lazily for chunked snapshots; only needed for CSV). */
  data(): unknown;
}

export async function loadSnapshot(env: Env, d: Database, sourceId: ObjectId): Promise<LoadedSnapshot | null> {
  const snap = await d.snapshots.findOne({ sourceId });
  if (!snap) return null;
  if (snap.storage === "drive") {
    let text: string;
    try {
      text = await readJsonFile(env, snap.driveFileId!);
    } catch (err) {
      // File deleted in Drive: forget the hash so the next refresh uploads it again.
      if (err instanceof DriveNotFound) await d.sources.updateOne({ _id: sourceId }, { $unset: { driveContentHash: 1 } });
      throw err;
    }
    let parsed: unknown;
    return { fetchedAt: snap.fetchedAt, sizeBytes: snap.sizeBytes, text, data: () => (parsed ??= JSON.parse(text)) };
  }
  if (snap.storage === "chunked") {
    const parts = await d.chunks.find({ sourceId, version: snap.chunkVersion }, { sort: { n: 1 }, projection: { text: 1 } }).toArray();
    if (parts.length !== snap.chunkCount) throw new Error("Snapshot is incomplete (chunks missing); it will be rewritten on the next fetch.");
    const text = parts.map((p) => p.text).join("");
    let parsed: unknown;
    return { fetchedAt: snap.fetchedAt, sizeBytes: snap.sizeBytes, text, data: () => (parsed ??= JSON.parse(text)) };
  }
  const data = (snap as SnapshotDoc).data;
  return { fetchedAt: snap.fetchedAt, sizeBytes: snap.sizeBytes, text: JSON.stringify(data), data: () => data };
}
