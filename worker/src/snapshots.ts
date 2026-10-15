import { BSON, type ObjectId } from "mongodb";
import type { Database, SnapshotDoc, SourceDoc } from "./db";
import { jsonFileName, readJsonFile, writeJsonFile } from "./drive";

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
 * Google Drive mode: the JSON goes to "<source name>.json" in the Drive folder; MongoDB keeps only
 * the file id (sources.driveFileId and snapshots.driveFileId).
 */
export async function saveToDrive(env: Env, d: Database, source: Pick<SourceDoc, "_id" | "name" | "driveFileId">, fetchedAt: Date, text: string, sizeBytes: number): Promise<"drive"> {
  const fileId = await writeJsonFile(env, { fileId: source.driveFileId ?? null, folderId: env.GOOGLE_DRIVE_FOLDER_ID!.trim(), name: jsonFileName(source.name), text, sizeBytes });
  if (fileId !== source.driveFileId) await d.sources.updateOne({ _id: source._id }, { $set: { driveFileId: fileId } });
  const before = await d.snapshots.findOneAndReplace(
    { sourceId: source._id },
    { sourceId: source._id, fetchedAt, sizeBytes, storage: "drive", driveFileId: fileId },
    { upsert: true, projection: { storage: 1 }, returnDocument: "before" },
  );
  if (before?.storage === "chunked") await d.chunks.deleteMany({ sourceId: source._id });
  return "drive";
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
    const text = await readJsonFile(env, snap.driveFileId!);
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
