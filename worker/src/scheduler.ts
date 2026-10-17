import { ensureIndexes, withDb } from "./db";
import { intVar, mapLimit } from "./http";
import { refreshSource } from "./refresh";
import { isActiveAt, nextActiveAt } from "./schedule";

// Cron runs every minute. Treat a source as due slightly early so a 5-minute interval does not
// slip to 6 minutes because the previous attempt started a few seconds after its cron tick.
const EARLY_MS = 30_000;
// Connecting to MongoDB costs CPU and subrequests, so the time the next source is due is kept
// in KV (shared by every Worker instance; one cheap read per tick). Cron ticks before that time stop at
// once — e.g. all night when every source is outside its working hours. Capped so changes
// made outside this app are still noticed within the hour.
const MAX_SKIP_MS = 60 * 60_000;
const NEXT_DUE_KEY = "scheduler:next-due";

async function readNextDue(env: Env): Promise<number> {
  const stored = Number(await env.SCHEDULER.get(NEXT_DUE_KEY).catch(() => null));
  return Number.isFinite(stored) ? stored : 0;
}

async function writeNextDue(env: Env, at: number, previous: number): Promise<void> {
  // KV allows 1,000 writes/day on the free plan: only write when the value really changes.
  if (Math.abs(at - previous) < 1_000) return;
  await env.SCHEDULER.put(NEXT_DUE_KEY, String(at)).catch((e) => console.error("scheduler: KV write failed", String(e)));
}

export async function runScheduler(env: Env, scheduledTime: number): Promise<void> {
  const now = scheduledTime || Date.now();
  const nextDue = await readNextDue(env);
  if (now < nextDue) {
    console.log(`scheduler: nothing due until ${new Date(nextDue).toISOString()}, skipped (no MongoDB)`);
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
        { sort: { lastFetchedAt: 1 } },
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
    const next = due.length >= maxPerRun ? 0 : Math.min(nextAt, Date.now() + MAX_SKIP_MS);
    await writeNextDue(env, next, nextDue);
    if (next > Date.now()) console.log(`scheduler: next work at ${new Date(next).toISOString()}`);
  });
}

/** After a source is created or edited: make the next cron tick look at MongoDB again. */
export function resetSchedulerMemo(env: Env, ctx: ExecutionContext): void {
  ctx.waitUntil(env.SCHEDULER.delete(NEXT_DUE_KEY).catch(() => {}));
}
