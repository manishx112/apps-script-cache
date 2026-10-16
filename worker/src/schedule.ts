// Per-source refresh window: which weekdays and which hours (in a timezone) the cron may call
// Apps Script. Outside the window nothing is fetched, which saves Apps Script and Worker quota.

import { HttpError } from "./http";

export interface Schedule {
  /** 0 = Sunday … 6 = Saturday */
  days: number[];
  /** "HH:MM", inclusive */
  start: string;
  /** "HH:MM" (or "24:00"), exclusive */
  end: string;
  /** IANA timezone, e.g. "Asia/Kolkata" */
  timezone: string;
}

const TIME_RE = /^(?:[01]\d|2[0-3]):[0-5]\d$|^24:00$/;
const toMinutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

/** Validates the `schedule` field of an API body. `null`/missing = refresh around the clock. */
export function parseSchedule(v: unknown): Schedule | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== "object" || Array.isArray(v)) throw new HttpError(400, "schedule must be an object or null.");
  const s = v as Record<string, unknown>;
  const days = Array.isArray(s.days) ? [...new Set(s.days.map(Number))].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).sort() : [];
  if (!days.length) throw new HttpError(400, "Choose at least one weekday.");
  if (typeof s.start !== "string" || !TIME_RE.test(s.start) || typeof s.end !== "string" || !TIME_RE.test(s.end)) {
    throw new HttpError(400, "Start and end time must look like 10:00 and 18:00.");
  }
  if (toMinutes(s.start) >= toMinutes(s.end)) throw new HttpError(400, "End time must be after start time.");
  const timezone = typeof s.timezone === "string" ? s.timezone.trim() : "";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch {
    throw new HttpError(400, `Unknown timezone "${timezone}".`);
  }
  if (!timezone) throw new HttpError(400, "Timezone is required.");
  return { days, start: s.start, end: s.end, timezone };
}

const formatters = new Map<string, Intl.DateTimeFormat>();
const WEEKDAY: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Wall-clock date/time of `at` in `tz`. */
function local(tz: string, at: number) {
  let f = formatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", weekday: "short", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric" });
    formatters.set(tz, f);
  }
  const p: Record<string, string> = {};
  for (const part of f.formatToParts(at)) p[part.type] = part.value;
  return { y: +p.year, m: +p.month, d: +p.day, day: WEEKDAY[p.weekday], minutes: +p.hour * 60 + +p.minute };
}

/** Offset of `tz` from UTC at instant `at`, in ms (e.g. +5:30 for India). */
function offsetMs(tz: string, at: number): number {
  const l = local(tz, at);
  return Date.UTC(l.y, l.m - 1, l.d) + l.minutes * 60_000 - Math.floor(at / 60_000) * 60_000;
}

export function isActiveAt(s: Schedule | null | undefined, at: number): boolean {
  if (!s) return true;
  const l = local(s.timezone, at);
  return s.days.includes(l.day) && l.minutes >= toMinutes(s.start) && l.minutes < toMinutes(s.end);
}

/** Earliest instant ≥ `at` inside the window (`at` itself when already inside). */
export function nextActiveAt(s: Schedule | null | undefined, at: number): number {
  if (!s || isActiveAt(s, at)) return at;
  const now = local(s.timezone, at);
  const startMin = toMinutes(s.start);
  for (let k = 0; k <= 7; k++) {
    const dayUtc = Date.UTC(now.y, now.m - 1, now.d + k); // midnight of that local date, as if UTC
    if (!s.days.includes(new Date(dayUtc).getUTCDay())) continue;
    if (k === 0 && now.minutes >= startMin) continue; // today's window already started (and ended)
    const guess = dayUtc + startMin * 60_000;
    let instant = guess - offsetMs(s.timezone, guess);
    instant = guess - offsetMs(s.timezone, instant); // second pass settles DST changes
    if (instant >= at) return instant;
  }
  return Number.POSITIVE_INFINITY;
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** "Mon–Sat · 10:00–18:00" */
export function describeSchedule(s: Schedule | null | undefined): string {
  if (!s) return "Every day · 24 h";
  const order = [1, 2, 3, 4, 5, 6, 0].filter((d) => s.days.includes(d));
  let days: string;
  if (order.length === 7) days = "Every day";
  else {
    // Collapse consecutive days (Mon..Sun order) into ranges.
    const runs: number[][] = [];
    for (const d of order) {
      const last = runs[runs.length - 1];
      const pos = (x: number) => (x + 6) % 7; // Mon=0 … Sun=6
      if (last && pos(d) === pos(last[last.length - 1]) + 1) last.push(d);
      else runs.push([d]);
    }
    days = runs.map((r) => (r.length > 2 ? `${DAY_NAMES[r[0]]}–${DAY_NAMES[r[r.length - 1]]}` : r.map((d) => DAY_NAMES[d]).join(", "))).join(", ");
  }
  return `${days} · ${s.start}–${s.end}`;
}
