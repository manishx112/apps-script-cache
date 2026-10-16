import { CalendarClock, Clock, Infinity as InfinityIcon, PiggyBank } from "lucide-react";
import type { Schedule } from "../api";

// Display order Mon → Sun; values are JS weekday numbers (0 = Sunday).
const DAYS = [
  { v: 1, label: "Mon" },
  { v: 2, label: "Tue" },
  { v: 3, label: "Wed" },
  { v: 4, label: "Thu" },
  { v: 5, label: "Fri" },
  { v: 6, label: "Sat" },
  { v: 0, label: "Sun" },
];

const PRESETS = [
  { label: "Mon–Fri", days: [1, 2, 3, 4, 5] },
  { label: "Mon–Sat", days: [1, 2, 3, 4, 5, 6] },
  { label: "Every day", days: [0, 1, 2, 3, 4, 5, 6] },
];

const browserTz = Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Kolkata";
// Chrome reports India as "Asia/Calcutta"; show the modern name.
const defaultTz = browserTz === "Asia/Calcutta" ? "Asia/Kolkata" : browserTz;

export function defaultSchedule(): Schedule {
  return { days: [1, 2, 3, 4, 5, 6], start: "10:00", end: "18:00", timezone: defaultTz };
}

const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));

export function scheduleError(s: Schedule | null): string | null {
  if (!s) return null;
  if (!s.days.length) return "Choose at least one day.";
  if (!/^\d\d:\d\d$/.test(s.start) || !/^\d\d:\d\d$/.test(s.end)) return "Enter a start and end time.";
  if (toMin(s.start) >= toMin(s.end)) return "End time must be after start time.";
  return null;
}

function timezones(current: string): string[] {
  const all = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  const top = ["Asia/Kolkata", "UTC", "Asia/Dubai", "Asia/Singapore", "Europe/London", "America/New_York"];
  return [...new Set([current, defaultTz, ...top, ...all])];
}

export default function ScheduleEditor({ value, intervalMin, onChange }: { value: Schedule | null; intervalMin: number; onChange: (s: Schedule | null) => void }) {
  const custom = value !== null;
  const s = value ?? defaultSchedule();
  const err = scheduleError(value);

  // Quota estimate: fetches per week with and without the window.
  const always = Math.floor((7 * 24 * 60) / intervalMin);
  const windowMin = custom && !err ? Math.max(0, toMin(s.end) - toMin(s.start)) : 24 * 60;
  const scheduled = custom && !err ? Math.ceil(windowMin / intervalMin) * s.days.length : always;
  const saved = always ? Math.round((1 - scheduled / always) * 100) : 0;

  const toggleDay = (d: number) => onChange({ ...s, days: s.days.includes(d) ? s.days.filter((x) => x !== d) : [...s.days, d] });

  return (
    <div className="space-y-3">
      <span className="label">When to refresh</span>
      <div className="grid gap-3 sm:grid-cols-2">
        <Choice active={!custom} onClick={() => onChange(null)} icon={<InfinityIcon className="size-4" />} title="Around the clock" text="Every day, 24 hours" />
        <Choice
          active={custom}
          onClick={() => !custom && onChange(defaultSchedule())}
          icon={<CalendarClock className="size-4" />}
          title="Only working days & hours"
          text="Skip nights and days off to save quota"
        />
      </div>

      {custom && (
        <div className="animate-fade-in space-y-4 rounded-2xl bg-slate-50 p-4 ring-1 ring-slate-200 ring-inset sm:p-5">
          <div>
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm font-medium text-slate-700">Days</span>
              <div className="flex gap-1">
                {PRESETS.map((p) => (
                  <button key={p.label} type="button" className="rounded-lg px-2 py-1 text-xs font-medium text-indigo-600 hover:bg-indigo-50" onClick={() => onChange({ ...s, days: p.days })}>
                    {p.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              {DAYS.map(({ v, label }) => {
                const on = s.days.includes(v);
                return (
                  <button
                    key={v}
                    type="button"
                    aria-pressed={on}
                    onClick={() => toggleDay(v)}
                    className={`w-12 rounded-xl py-2 text-sm font-medium transition-all ${
                      on ? "bg-indigo-600 text-white shadow-sm shadow-indigo-600/30" : "bg-white text-slate-500 ring-1 ring-slate-200 hover:text-slate-800"
                    }`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <label htmlFor="start" className="mb-1 block text-sm font-medium text-slate-700">
                From
              </label>
              <input id="start" type="time" className="input" value={s.start} onChange={(e) => onChange({ ...s, start: e.target.value })} required />
            </div>
            <div>
              <label htmlFor="end" className="mb-1 block text-sm font-medium text-slate-700">
                To
              </label>
              <input id="end" type="time" className="input" value={s.end} onChange={(e) => onChange({ ...s, end: e.target.value })} required />
            </div>
            <div>
              <label htmlFor="tz" className="mb-1 block text-sm font-medium text-slate-700">
                Timezone
              </label>
              <select id="tz" className="input" value={s.timezone} onChange={(e) => onChange({ ...s, timezone: e.target.value })}>
                {timezones(s.timezone).map((tz) => (
                  <option key={tz} value={tz}>
                    {tz.replace(/_/g, " ")}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {err ? (
            <p className="text-sm text-red-600">{err}</p>
          ) : (
            <p className="flex items-start gap-2 text-sm text-slate-600">
              <Clock className="mt-0.5 size-4 shrink-0 text-indigo-500" />
              Outside these hours the link keeps serving the last data, and <b>Refresh now</b> still works any time.
            </p>
          )}
        </div>
      )}

      <p className="flex items-center gap-2 rounded-xl bg-emerald-50 px-3 py-2 text-sm text-emerald-800 ring-1 ring-emerald-200 ring-inset">
        <PiggyBank className="size-4 shrink-0" />
        About <b>{scheduled.toLocaleString()}</b> Apps Script calls per week
        {custom && !err && saved > 0 ? (
          <>
            {" "}
            instead of {always.toLocaleString()} — <b>{saved}% fewer</b>
          </>
        ) : null}
        .
      </p>
    </div>
  );
}

function Choice({ active, onClick, icon, title, text }: { active: boolean; onClick: () => void; icon: React.ReactNode; title: string; text: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`flex items-start gap-3 rounded-2xl p-4 text-left transition-all ${
        active ? "bg-indigo-50 ring-2 ring-indigo-500" : "bg-white ring-1 ring-slate-200 hover:ring-slate-300"
      }`}
    >
      <span className={`flex size-8 shrink-0 items-center justify-center rounded-lg ${active ? "bg-indigo-600 text-white" : "bg-slate-100 text-slate-500"}`}>{icon}</span>
      <span>
        <span className="block text-sm font-semibold text-slate-900">{title}</span>
        <span className="block text-xs text-slate-500">{text}</span>
      </span>
    </button>
  );
}
