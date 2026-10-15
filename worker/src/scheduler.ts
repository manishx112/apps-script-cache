import { ensureIndexes, withDb } from "./db";
import { intVar, mapLimit } from "./http";
import { refreshSource } from "./refresh";

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
    const dueFilter = {
      status: "active" as const,
      $or: [
        { lastFetchedAt: null },
        { $expr: { $lte: [{ $add: ["$lastFetchedAt", { $multiply: ["$intervalMin", 60_000] }] }, new Date(now + EARLY_MS)] } },
      ],
    };
    const due = await d.sources
      .find(dueFilter, { projection: { _id: 1, scriptUrl: 1, token: 1, lastFetchedAt: 1 }, sort: { lastFetchedAt: 1 }, limit: maxPerRun })
      .toArray();

    const results = await mapLimit(due, concurrency, async (s) => {
      // Claim the source so an overlapping cron run does not fetch it twice.
      const claim = await d.sources.updateOne({ _id: s._id, lastFetchedAt: s.lastFetchedAt }, { $set: { lastFetchedAt: new Date() } });
      if (claim.modifiedCount !== 1) return null;
      return refreshSource(env, d, s, timeoutMs);
    });
    const done = results.filter((r) => r !== null);
    if (done.length) console.log(`scheduler: refreshed ${done.length} source(s), ${done.filter((r) => !r.ok).length} failed`);

    // When is the next active source due?
    const [next] = await d.sources
      .aggregate<{ at: Date }>([
        { $match: { status: "active" } },
        { $project: { at: { $ifNull: [{ $add: ["$lastFetchedAt", { $multiply: ["$intervalMin", 60_000] }] }, new Date(0)] } } },
        { $sort: { at: 1 } },
        { $limit: 1 },
      ])
      .toArray();
    const nextAt = next ? next.at.getTime() - EARLY_MS : Number.POSITIVE_INFINITY;
    nextDueAt = due.length >= maxPerRun ? 0 : Math.min(nextAt, Date.now() + MAX_SKIP_MS);
  });
}

/** Called after admin edits in this isolate so the next cron tick re-checks MongoDB. */
export function resetSchedulerMemo(): void {
  nextDueAt = 0;
}
