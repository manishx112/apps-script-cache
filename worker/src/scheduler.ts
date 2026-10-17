import { claimSource, listSources, pruneLogs, type SourceDoc } from "./db";
import { intVar, mapLimit } from "./http";
import { refreshSource } from "./refresh";
import { isActiveAt, nextActiveAt } from "./schedule";

// Refresh slots are aligned to the clock: a 15-minute source runs at :00, :15, :30, :45, a 5-minute
// source at :00, :05, … So every source with the same interval is refreshed in the same cron run,
// and the "next work" note below is written once per slot instead of once per source.
const slotStart = (t: number, intervalMin: number) => Math.floor(t / (intervalMin * 60_000)) * intervalMin * 60_000;

// Ticks with nothing due skip the database until the next slot that has work. The time is kept in
// KV (shared by every Worker instance, one cheap read per tick; free tier allows 1,000 writes/day)
// and, to save even that read, in this instance's memory.
// Editing a source deletes the note so the change applies on the next tick.
const MAX_SKIP_MS = 6 * 60 * 60_000;
const MAX_MEMO_MS = 5 * 60_000;
const NEXT_DUE_KEY = "scheduler:next-due";
const PRUNE_EVERY_MS = 60 * 60_000;
let memoUntil = 0;
let lastPruneAt = 0;

async function readNextDue(env: Env, now: number): Promise<number> {
  if (memoUntil > now) return memoUntil;
  const stored = Number(await env.SCHEDULER.get(NEXT_DUE_KEY).catch(() => null));
  return Number.isFinite(stored) ? stored : 0;
}

export async function runScheduler(env: Env, scheduledTime: number): Promise<void> {
  const now = scheduledTime || Date.now();
  const nextDue = await readNextDue(env, now);
  if (now < nextDue) {
    console.log(`scheduler: nothing due until ${new Date(nextDue).toISOString()}, skipped (no database)`);
    return;
  }
  const maxPerRun = intVar(env.MAX_SOURCES_PER_RUN, 10);
  const concurrency = intVar(env.FETCH_CONCURRENCY, 2);
  const timeoutMs = intVar(env.FETCH_TIMEOUT_MS, 25_000);

  const active = await listSources(env, true);
  // Due = not yet fetched in the current slot of its interval, and inside its working hours.
  const fetchedThisSlot = (s: SourceDoc) => !!s.lastFetchedAt && s.lastFetchedAt.getTime() >= slotStart(now, s.intervalMin);
  const due = active.filter((s) => !fetchedThisSlot(s) && isActiveAt(s.schedule, now)).slice(0, maxPerRun);

  const results = await mapLimit(due, concurrency, async (s) => {
    // Claim the source so an overlapping cron run does not fetch it twice.
    if (!(await claimSource(env, s, new Date()))) return null;
    return refreshSource(env, s, timeoutMs);
  });
  const done = results.filter((r) => r !== null);
  if (done.length) {
    console.log(`scheduler: refreshed ${done.length} source(s), ${done.filter((r) => !r.ok).length} failed`);
    // Fetch logs older than 7 days (SQLite has no TTL index). Only on ticks that did work.
    if (Date.now() - lastPruneAt > PRUNE_EVERY_MS) {
      lastPruneAt = Date.now();
      await pruneLogs(env).catch((e) => console.error("scheduler: log prune failed", String(e)));
    }
  }

  if (due.length >= maxPerRun) {
    memoUntil = 0; // more sources waiting in this slot: continue on the next tick
    return;
  }

  // Next slot with work: each source's next slot start, moved into its working hours.
  const ran = new Set(due.map((s) => s.id));
  let nextAt = Number.POSITIVE_INFINITY;
  for (const s of active) {
    const base = ran.has(s.id) || fetchedThisSlot(s) ? slotStart(now, s.intervalMin) + s.intervalMin * 60_000 : now;
    nextAt = Math.min(nextAt, nextActiveAt(s.schedule, base));
  }
  const until = Math.min(nextAt, Date.now() + MAX_SKIP_MS);
  memoUntil = Math.min(until, Date.now() + MAX_MEMO_MS);
  if (until > Date.now() + 60_000 && Math.abs(until - nextDue) >= 1_000) {
    await env.SCHEDULER.put(NEXT_DUE_KEY, String(until)).catch((e) => console.error("scheduler: KV write failed", String(e)));
  }
  console.log(`scheduler: next work at ${new Date(until).toISOString()}`);
}

/** After a source is created or edited: make the next cron tick look at the database again. */
export function resetSchedulerMemo(env: Env, ctx: ExecutionContext): void {
  memoUntil = 0;
  ctx.waitUntil(env.SCHEDULER.delete(NEXT_DUE_KEY).catch(() => {}));
}
