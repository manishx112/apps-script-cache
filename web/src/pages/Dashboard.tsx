import { Activity, CircleCheck, Moon, CirclePause, Database, ExternalLink, Pause, Pencil, Play, Plus, RefreshCw, RotateCcw, Trash2, TriangleAlert } from "lucide-react";
import { type ComponentType, useCallback, useState } from "react";
import { Link } from "react-router";
import { api, ApiError, dataUrl, type Source } from "../api";
import { CopyButton, EmptyState, ErrorBox, Skeleton, Spinner, StatusBadge } from "../components/ui";
import DataHealth from "../components/DataHealth";
import { useSourceActions } from "../components/useSourceActions";
import { formatBytes, formatMs, timeAgo, useNow, usePolling } from "../lib/format";

export default function Dashboard() {
  const [sources, setSources] = useState<Source[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const now = useNow(15_000);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const { sources } = await api.listSources();
      setSources(sources);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load sources.");
    } finally {
      setRefreshing(false);
    }
  }, []);
  usePolling(load, 300_000);

  const { actions, busy, dialog } = useSourceActions((id, updated) =>
    setSources((list) => (list ? (updated ? list.map((s) => (s.id === id ? updated : s)) : list.filter((s) => s.id !== id)) : list)),
  );

  const count = (h: Source["health"]) => sources?.filter((s) => s.health === h).length ?? 0;

  return (
    <div className="space-y-8">
      {dialog}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight text-slate-900">Sources</h1>
          <p className="mt-1 flex items-center gap-2 text-sm text-slate-500">
            Every Apps Script URL you cache, with its live status.
            {refreshing && sources ? <Spinner className="size-3.5 text-slate-400" /> : <span className="text-slate-400">· auto-refresh 5 min</span>}
          </p>
        </div>
        <Link to="/sources/new" className="btn-primary">
          <Plus className="size-4" /> Add source
        </Link>
      </div>

      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Stat icon={Database} label="Total sources" value={sources?.length} accent="from-indigo-500 to-violet-500" />
        <Stat icon={CircleCheck} label="Healthy" value={sources && count("ok")} accent="from-emerald-500 to-teal-500" />
        <Stat icon={TriangleAlert} label="Failing" value={sources && count("error")} accent="from-rose-500 to-red-500" />
        <Stat icon={CirclePause} label="Paused" value={sources && count("paused")} accent="from-slate-400 to-slate-500" />
      </div>

      {error && <ErrorBox message={error} onRetry={load} />}

      {sources === null && !error ? (
        <div className="card divide-y divide-slate-100">
          {[0, 1, 2].map((i) => (
            <div key={i} className="flex items-center gap-4 px-5 py-4">
              <Skeleton className="size-10 rounded-xl" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-48" />
                <Skeleton className="h-3 w-72" />
              </div>
              <Skeleton className="h-6 w-20 rounded-full" />
            </div>
          ))}
        </div>
      ) : sources && sources.length === 0 ? (
        <EmptyState
          title="Cache your first Apps Script"
          action={
            <Link to="/sources/new" className="btn-primary">
              <Plus className="size-4" /> Add source
            </Link>
          }
        >
          Paste an Apps Script <code className="rounded bg-slate-100 px-1">/exec</code> URL and get a fast, permanent link for Power BI, Excel, Looker or React.
        </EmptyState>
      ) : sources ? (
        <div className="card overflow-hidden">
          <div className="hidden grid-cols-[minmax(0,2.2fr)_0.8fr_1fr_0.9fr_1fr_auto] gap-4 border-b border-slate-100 bg-slate-50/70 px-5 py-3 text-xs font-medium tracking-wide text-slate-500 uppercase md:grid">
            <span>Source</span>
            <span>Interval</span>
            <span>Last success</span>
            <span>Status</span>
            <span>Speed · Size</span>
            <span className="w-[13.5rem] text-right">Actions</span>
          </div>
          <ul className="divide-y divide-slate-100">
            {sources.map((s) => (
              <li
                key={s.id}
                className="grid gap-3 px-5 py-4 transition-colors hover:bg-slate-50/70 md:grid-cols-[minmax(0,2.2fr)_0.8fr_1fr_0.9fr_1fr_auto] md:items-center md:gap-4"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <div className={`flex size-10 shrink-0 items-center justify-center rounded-xl ${iconTone(s)}`}>
                    <Activity className="size-5" />
                  </div>
                  <div className="min-w-0">
                    <Link to={`/sources/${s.id}`} className="block truncate font-medium text-slate-900 hover:text-indigo-600">
                      {s.name}
                    </Link>
                    {s.lastError ? (
                      <p className="truncate text-xs text-red-600" title={s.lastError}>
                        {s.lastError}
                      </p>
                    ) : (
                      <p className="truncate font-mono text-xs text-slate-400">/d/{s.token.slice(0, 10)}…</p>
                    )}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2 text-sm md:contents">
                  <span className="flex flex-col items-start gap-0.5">
                    <span className="rounded-lg bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-600">{s.intervalMin} min</span>
                    {s.schedule && (
                      <span className="text-[11px] whitespace-nowrap text-slate-400" title={s.schedule.timezone}>
                        {s.scheduleText}
                      </span>
                    )}
                    {s.schedule && !s.inWindow && s.status === "active" && (
                      <span className="inline-flex items-center gap-1 text-[11px] font-medium text-indigo-500" title={s.nextWindowAt ? `Next refresh window: ${new Date(s.nextWindowAt).toLocaleString()}` : undefined}>
                        <Moon className="size-3" /> Off-hours
                      </span>
                    )}
                  </span>
                  <span className="text-slate-600" title={s.lastSuccessAt ?? undefined}>
                    {timeAgo(s.lastSuccessAt, now)}
                  </span>
                  <span>
                    <StatusBadge health={s.health} />
                  </span>
                  <span className="text-slate-600">
                    {formatMs(s.lastDurationMs)} <span className="text-slate-300">·</span> {formatBytes(s.lastSizeBytes)}
                    {(s.lastSizeBytes ?? 0) > 5 * 1024 * 1024 && <TriangleAlert className="ml-1 inline size-3.5 text-amber-500" />}
                  </span>
                </div>
                <Actions s={s} busy={busy[s.id]} actions={actions} />
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {sources && sources.length > 0 && <DataHealth />}
    </div>
  );
}

function iconTone(s: Source): string {
  return {
    ok: "bg-emerald-50 text-emerald-600",
    error: "bg-red-50 text-red-600",
    paused: "bg-slate-100 text-slate-500",
    pending: "bg-amber-50 text-amber-600",
  }[s.health];
}

function Stat({ icon: Icon, label, value, accent }: { icon: ComponentType<{ className?: string }>; label: string; value: number | null | undefined; accent: string }) {
  return (
    <div className="card relative overflow-hidden p-5">
      <div className={`absolute -top-6 -right-6 size-24 rounded-full bg-gradient-to-br opacity-10 ${accent}`} />
      <div className={`flex size-9 items-center justify-center rounded-xl bg-gradient-to-br text-white shadow-sm ${accent}`}>
        <Icon className="size-4.5" />
      </div>
      <p className="mt-4 text-sm text-slate-500">{label}</p>
      {value === null || value === undefined ? <Skeleton className="mt-1 h-8 w-12" /> : <p className="text-3xl font-semibold tracking-tight text-slate-900">{value}</p>}
    </div>
  );
}

function Actions({ s, busy, actions }: { s: Source; busy?: string; actions: ReturnType<typeof useSourceActions>["actions"] }) {
  return (
    <div className="flex items-center gap-0.5 md:w-[13.5rem] md:justify-end">
      <button className="icon-btn" onClick={() => actions.refresh(s)} disabled={!!busy} title="Refresh now" aria-label="Refresh now">
        <RefreshCw className={`size-4 ${busy === "refresh" ? "animate-spin text-indigo-600" : ""}`} />
      </button>
      <button className="icon-btn" onClick={() => actions.toggle(s)} disabled={!!busy} title={s.status === "active" ? "Pause" : "Resume"} aria-label={s.status === "active" ? "Pause" : "Resume"}>
        {busy === "toggle" ? <Spinner /> : s.status === "active" ? <Pause className="size-4" /> : <Play className="size-4" />}
      </button>
      <CopyButton text={dataUrl(s.token)} label="Copy link" className="icon-btn" iconOnly />
      <a className="icon-btn" href={dataUrl(s.token)} target="_blank" rel="noreferrer" title="Open link" aria-label="Open link">
        <ExternalLink className="size-4" />
      </a>
      <Link to={`/sources/${s.id}/edit`} className="icon-btn" title="Edit" aria-label="Edit">
        <Pencil className="size-4" />
      </Link>
      <button className="icon-btn" onClick={() => actions.rotate(s)} disabled={!!busy} title="Rotate link" aria-label="Rotate link">
        <RotateCcw className="size-4" />
      </button>
      <button className="icon-btn hover:bg-red-50 hover:text-red-600" onClick={() => actions.delete(s)} disabled={!!busy} title="Delete" aria-label="Delete">
        <Trash2 className="size-4" />
      </button>
    </div>
  );
}
