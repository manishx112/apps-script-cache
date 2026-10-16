import { ensureIndexes, withDb } from "./db";
import { intVar, mapLimit } from "./http";
import { refreshSource } from "./refresh";
import { isActiveAt, nextActiveAt } from "./schedule";

// Cron runs every minute. Treat a source as due slightly early so a 5-minute interval does not
// slip to 6 minutes because the previous attempt started a few seconds after its cron tick.
const EARLY_MS = 30_000;
// While an isolate stays warm it remembers when the next source is due and skips MongoDB until
// then (each MongoDB connection costs CPU). Capped so edits made elsewhere are picked up soon.
const MAX_SKIP_MS = 5 * 60_000;
let nextDueAt = 0;

export async function runScheduler(env: Env, scheduledTime: number): Promise<void> {
  const now = scheduledTime || Date.now();
  if (now < nextDueAt) {
    console.log(`scheduler: nothing due until ${new Date(nextDueAt).toISOString()}, skipped`);
    return;
  }
  const maxPerRun = intVar(env.MAX_SOURCES_PER_RUN, 10);
  const concurrency = intVar(env.FETCH_CONCURRENCY, 2);
  const timeoutMs = intVar(env.FETCH_TIMEOUT_MS, 25_000);

  await withDb(env, null, async (d) => {
    await ensureIndexes(d);
    // Few enough sources to decide in code: interval elapsed AND inside the source's schedule window.
    const active = await d.sources
      .find(
        { status: "active" },
        { projection: { _id: 1, scriptUrl: 1, token: 1, name: 1, driveFileId: 1, driveFolderId: 1, driveContentHash: 1, lastFetchedAt: 1, intervalMin: 1, schedule: 1 }, sort: { lastFetchedAt: 1 } },
      )
      .toArray();
    const intervalDue = (s: (typeof active)[number]) => (s.lastFetchedAt ? s.lastFetchedAt.getTime() + s.intervalMin * 60_000 - EARLY_MS : 0);
    const due = active.filter((s) => intervalDue(s) <= now && isActiveAt(s.schedule, now)).slice(0, maxPerRun);

    const results = await mapLimit(due, concurrency, async (s) => {
      // Claim the source so an overlapping cron run does not fetch it twice.
      const claim = await d.sources.updateOne({ _id: s._id, lastFetchedAt: s.lastFetchedAt }, { $set: { lastFetchedAt: new Date() } });
      if (claim.modifiedCount !== 1) return null;
      return refreshSource(env, d, s, timeoutMs);
    });
    const done = results.filter((r) => r !== null);
    if (done.length) console.log(`scheduler: refreshed ${done.length} source(s), ${done.filter((r) => !r.ok).length} failed`);

    // When is the next source due (interval elapsed and its window open)?
    const fetched = new Set(due.map((s) => String(s._id)));
    let nextAt = Number.POSITIVE_INFINITY;
    for (const s of active) {
      const base = fetched.has(String(s._id)) ? Date.now() + s.intervalMin * 60_000 - EARLY_MS : Math.max(intervalDue(s), Date.now());
      nextAt = Math.min(nextAt, nextActiveAt(s.schedule, base));
    }
    nextDueAt = due.length >= maxPerRun ? 0 : Math.min(nextAt, Date.now() + MAX_SKIP_MS);
  });
}

/** Called after admin edits in this isolate so the next cron tick re-checks MongoDB. */
export function resetSchedulerMemo(): void {
  nextDueAt = 0;
}
