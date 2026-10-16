// Database health: what is stored, what is redundant or orphaned, and a safe cleanup.
// Only data this app created is ever removed; unknown collections are reported, never touched.

import type { ObjectId } from "mongodb";
import type { Database } from "./db";
import { driveEnabled } from "./drive";

const APP_COLLECTIONS = ["sources", "snapshots", "snapshot_chunks", "fetch_logs"];
/** Collections created during setup/testing that the app no longer uses. */
const LEFTOVER_COLLECTIONS = ["step0_test", "setup_check"];
const FREE_TIER_BYTES = 512 * 1024 * 1024;

export interface DataReport {
  dataSizeBytes: number;
  storageSizeBytes: number;
  indexSizeBytes: number;
  quotaBytes: number;
  collections: { name: string; documents: number; kind: "app" | "leftover" | "other" }[];
  issues: {
    /** snapshots / chunks / logs whose source was deleted */
    orphanSnapshots: number;
    orphanChunks: number;
    orphanLogs: number;
    /** snapshot copies kept in MongoDB for sources whose data now lives in Google Drive */
    redundantSnapshots: number;
    /** chunk pieces from an older version of a large snapshot */
    staleChunks: number;
    leftoverCollections: string[];
  };
  totalIssues: number;
}

async function analyse(d: Database, env: Env) {
  const sourceIds = (await d.sources.find({}, { projection: { _id: 1 } }).toArray()).map((s) => s._id);
  const driveIds: ObjectId[] = driveEnabled(env)
    ? (await d.sources.find({ driveFileId: { $nin: [null, ""] } }, { projection: { _id: 1 } }).toArray()).map((s) => s._id)
    : [];
  // Chunk pieces are current only when they match their snapshot's chunkVersion.
  const chunked = await d.snapshots.find({ storage: "chunked" }, { projection: { sourceId: 1, chunkVersion: 1 } }).toArray();
  const currentChunks = chunked.map((s) => ({ sourceId: s.sourceId, version: s.chunkVersion! }));
  const filters = {
    orphanSnapshots: { sourceId: { $nin: sourceIds } },
    orphanChunks: { sourceId: { $nin: sourceIds } },
    orphanLogs: { sourceId: { $nin: sourceIds } },
    redundantSnapshots: { sourceId: { $in: driveIds } },
    staleChunks: currentChunks.length ? { sourceId: { $in: sourceIds }, $nor: currentChunks } : { sourceId: { $in: sourceIds } },
  };
  return { filters, driveIds };
}

export async function dataReport(env: Env, d: Database): Promise<DataReport> {
  const [{ filters }, stats, collections] = await Promise.all([
    analyse(d, env),
    d.db.command({ dbStats: 1, scale: 1 }),
    d.db.listCollections({}, { nameOnly: true }).toArray(),
  ]);
  const [orphanSnapshots, orphanChunks, orphanLogs, redundantSnapshots, staleChunks] = await Promise.all([
    d.snapshots.countDocuments(filters.orphanSnapshots),
    d.chunks.countDocuments(filters.orphanChunks),
    d.logs.countDocuments(filters.orphanLogs),
    d.snapshots.countDocuments(filters.redundantSnapshots),
    d.chunks.countDocuments(filters.staleChunks),
  ]);
  const names = collections.map((c) => c.name).filter((n) => !n.startsWith("system."));
  const counts = await Promise.all(names.map((n) => d.db.collection(n).estimatedDocumentCount()));
  const leftoverCollections = names.filter((n) => LEFTOVER_COLLECTIONS.includes(n));
  const issues = { orphanSnapshots, orphanChunks, orphanLogs, redundantSnapshots, staleChunks, leftoverCollections };
  return {
    dataSizeBytes: Number(stats.dataSize ?? 0),
    storageSizeBytes: Number(stats.storageSize ?? 0),
    indexSizeBytes: Number(stats.indexSize ?? 0),
    quotaBytes: FREE_TIER_BYTES,
    collections: names
      .map((name, i) => ({ name, documents: counts[i], kind: APP_COLLECTIONS.includes(name) ? ("app" as const) : LEFTOVER_COLLECTIONS.includes(name) ? ("leftover" as const) : ("other" as const) }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    issues,
    totalIssues: orphanSnapshots + orphanChunks + orphanLogs + redundantSnapshots + staleChunks + leftoverCollections.length,
  };
}

export async function cleanUp(env: Env, d: Database) {
  const { filters, driveIds } = await analyse(d, env);
  const [orphanSnapshots, orphanChunks, orphanLogs, redundantSnapshots, staleChunks] = await Promise.all([
    d.snapshots.deleteMany(filters.orphanSnapshots),
    d.chunks.deleteMany(filters.orphanChunks),
    d.logs.deleteMany(filters.orphanLogs),
    d.snapshots.deleteMany(filters.redundantSnapshots),
    d.chunks.deleteMany(filters.staleChunks),
  ]);
  // Chunks of Drive-mode sources are redundant too (their snapshot was just removed).
  const driveChunks = driveIds.length ? await d.chunks.deleteMany({ sourceId: { $in: driveIds } }) : { deletedCount: 0 };
  const existing = (await d.db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name);
  const dropped: string[] = [];
  for (const name of LEFTOVER_COLLECTIONS) {
    if (existing.includes(name)) {
      await d.db.dropCollection(name);
      dropped.push(name);
    }
  }
  return {
    removed: {
      orphanSnapshots: orphanSnapshots.deletedCount,
      orphanChunks: orphanChunks.deletedCount,
      orphanLogs: orphanLogs.deletedCount,
      redundantSnapshots: redundantSnapshots.deletedCount,
      staleChunks: staleChunks.deletedCount + driveChunks.deletedCount,
    },
    droppedCollections: dropped,
  };
}
