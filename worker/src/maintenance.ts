// Database health: what is stored, what is redundant or orphaned, and a safe cleanup.
// Only rows this app created are ever removed.

import { db, LOG_RETENTION_MS } from "./db";
import { driveEnabled } from "./drive";

/** Workers Free plan: 500 MB per D1 database. */
const FREE_TIER_BYTES = 500 * 1000 * 1000;
const TABLES = ["sources", "snapshots", "snapshot_chunks", "fetch_logs"];

export interface DataReport {
  sizeBytes: number;
  quotaBytes: number;
  tables: { name: string; rows: number }[];
  issues: {
    /** snapshots / chunks / logs whose source was deleted */
    orphanSnapshots: number;
    orphanChunks: number;
    orphanLogs: number;
    /** snapshot copies kept in D1 for sources whose data now lives in Google Drive */
    redundantSnapshots: number;
    /** chunk pieces from an older version of a snapshot */
    staleChunks: number;
    /** fetch logs older than 7 days (normally removed by the cron) */
    expiredLogs: number;
  };
  totalIssues: number;
}

type Issue = keyof DataReport["issues"];

/** WHERE clauses selecting each kind of removable row. `?1` = log cutoff time. */
function conditions(drive: boolean): Record<Issue, { table: string; where: string }> {
  return {
    orphanSnapshots: { table: "snapshots", where: "sourceId NOT IN (SELECT id FROM sources)" },
    orphanChunks: { table: "snapshot_chunks", where: "sourceId NOT IN (SELECT id FROM sources)" },
    orphanLogs: { table: "fetch_logs", where: "sourceId NOT IN (SELECT id FROM sources)" },
    redundantSnapshots: {
      table: "snapshots",
      where: drive ? "sourceId IN (SELECT id FROM sources WHERE driveFileId IS NOT NULL AND driveFileId <> '')" : "0",
    },
    staleChunks: {
      table: "snapshot_chunks",
      where: "sourceId IN (SELECT id FROM sources) AND NOT EXISTS (SELECT 1 FROM snapshots s WHERE s.sourceId = snapshot_chunks.sourceId AND s.chunkVersion = snapshot_chunks.version)",
    },
    expiredLogs: { table: "fetch_logs", where: "at < ?1" },
  };
}

export async function dataReport(env: Env): Promise<DataReport> {
  const d = await db(env);
  const cutoff = Date.now() - LOG_RETENTION_MS;
  const conds = Object.entries(conditions(driveEnabled(env))) as [Issue, { table: string; where: string }][];
  const results = await d.batch<{ n: number }>([
    ...TABLES.map((t) => d.prepare(`SELECT COUNT(*) AS n FROM ${t}`)),
    ...conds.map(([, c]) => d.prepare(`SELECT COUNT(*) AS n FROM ${c.table} WHERE ${c.where}`).bind(...(c.where.includes("?1") ? [cutoff] : []))),
  ]);
  const count = (i: number) => Number(results[i].results[0]?.n ?? 0);
  const issues = Object.fromEntries(conds.map(([k], i) => [k, count(TABLES.length + i)])) as DataReport["issues"];
  return {
    sizeBytes: Number(results[0].meta.size_after ?? 0),
    quotaBytes: FREE_TIER_BYTES,
    tables: TABLES.map((name, i) => ({ name, rows: count(i) })),
    issues,
    totalIssues: Object.values(issues).reduce((a, b) => a + b, 0),
  };
}

export async function cleanUp(env: Env) {
  const d = await db(env);
  const cutoff = Date.now() - LOG_RETENTION_MS;
  const conds = Object.entries(conditions(driveEnabled(env))) as [Issue, { table: string; where: string }][];
  // Snapshots first, so chunks left without a current snapshot are caught as stale in the same run.
  const order: Issue[] = ["orphanSnapshots", "redundantSnapshots", "orphanChunks", "staleChunks", "orphanLogs", "expiredLogs"];
  const byKey = Object.fromEntries(conds);
  const results = await d.batch(
    order.map((k) => d.prepare(`DELETE FROM ${byKey[k].table} WHERE ${byKey[k].where}`).bind(...(byKey[k].where.includes("?1") ? [cutoff] : []))),
  );
  return { removed: Object.fromEntries(order.map((k, i) => [k, results[i].meta.changes])) as Record<Issue, number> };
}
