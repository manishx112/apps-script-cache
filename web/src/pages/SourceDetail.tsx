import { ArrowLeft, Braces, FolderOpen, ChartColumn, Clock, ExternalLink, FileSpreadsheet, Gauge, HardDrive, Info, Pause, Pencil, Play, RefreshCw, RotateCcw, Timer, Trash2 } from "lucide-react";
import { type ComponentType, useCallback, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { api, ApiError, dataUrl, type FetchLog, type Source } from "../api";
import { CodeBlock, CopyButton, ErrorBox, Skeleton, Spinner, StatusBadge } from "../components/ui";
import { useSourceActions } from "../components/useSourceActions";
import { formatBytes, formatDateTime, formatMs, timeAgo, useNow, usePolling } from "../lib/format";

type Tab = "powerbi" | "excel" | "js";

export default function SourceDetail() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const now = useNow(15_000);
  const [source, setSource] = useState<Source | null>(null);
  const [logs, setLogs] = useState<FetchLog[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("powerbi");

  const load = useCallback(async () => {
    try {
      const [{ source }, { logs }] = await Promise.all([api.getSource(id), api.logs(id)]);
      setSource(source);
      setLogs(logs);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Could not load the source.");
    }
  }, [id]);
  usePolling(load, 180_000);

  const { actions, busy, dialog } = useSourceActions((_, updated) => {
    if (!updated) return navigate("/");
    setSource(updated);
    api.logs(id).then(({ logs }) => setLogs(logs), () => {});
  });

  if (error && !source) return <ErrorBox message={error} onRetry={load} />;
  if (!source) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-40 w-full rounded-2xl" />
        <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-24 rounded-2xl" />
          ))}
        </div>
      </div>
    );
  }

  const link = dataUrl(source.token);
  const csvLink = dataUrl(source.token, true);
  const metaLink = `${link}/meta`;
  const b = busy[source.id];
  const okCount = logs?.filter((l) => l.ok).length ?? 0;

  return (
    <div className="space-y-8">
      {dialog}
      <div>
        <Link to="/" className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-900">
          <ArrowLeft className="size-4" /> All sources
        </Link>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-4">
          <div className="flex min-w-0 items-center gap-3">
            <h1 className="truncate text-3xl font-semibold tracking-tight text-slate-900">{source.name}</h1>
            <StatusBadge health={source.health} />
          </div>
          <div className="flex flex-wrap gap-2">
            <button className="btn-primary" onClick={() => actions.refresh(source)} disabled={!!b}>
              <RefreshCw className={`size-4 ${b === "refresh" ? "animate-spin" : ""}`} /> Refresh now
            </button>
            <button className="btn-secondary" onClick={() => actions.toggle(source)} disabled={!!b}>
              {b === "toggle" ? <Spinner /> : source.status === "active" ? <Pause className="size-4" /> : <Play className="size-4" />}
              {source.status === "active" ? "Pause" : "Resume"}
            </button>
            <Link to={`/sources/${source.id}/edit`} className="btn-secondary">
              <Pencil className="size-4" /> Edit
            </Link>
            <button className="btn-secondary" onClick={() => actions.rotate(source)} disabled={!!b}>
              <RotateCcw className="size-4" /> Rotate link
            </button>
            <button className="btn-secondary text-red-600 hover:bg-red-50 hover:text-red-700" onClick={() => actions.delete(source)} disabled={!!b}>
              <Trash2 className="size-4" /> Delete
            </button>
          </div>
        </div>
      </div>

      {error && <ErrorBox message={error} onRetry={load} />}

      {/* Hero link card */}
      <section className="relative overflow-hidden rounded-3xl bg-slate-950 p-6 text-white shadow-xl shadow-indigo-900/20 sm:p-8">
        <div className="pointer-events-none absolute -top-24 -right-16 size-72 rounded-full bg-indigo-600/40 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-32 left-10 size-72 rounded-full bg-fuchsia-600/25 blur-3xl" />
        <div className="relative">
          <p className="flex items-center gap-2 text-sm font-medium text-indigo-200">
            <Braces className="size-4" /> Your fast JSON link
          </p>
          <div className="mt-3 flex flex-col gap-3 sm:flex-row">
            <input
              readOnly
              value={link}
              onFocus={(e) => e.target.select()}
              className="block w-full rounded-xl border-0 bg-white/10 px-4 py-3.5 font-mono text-sm text-white ring-1 ring-white/15 ring-inset focus:ring-2 focus:ring-indigo-400 focus:outline-none sm:text-base"
            />
            <div className="flex gap-2">
              <CopyButton text={link} label="Copy link" className="btn flex-1 bg-white px-5 text-slate-900 hover:bg-indigo-50 sm:flex-none" />
              <a href={link} target="_blank" rel="noreferrer" className="btn bg-white/10 text-white ring-1 ring-white/15 hover:bg-white/20" title="Open">
                <ExternalLink className="size-4" />
              </a>
            </div>
          </div>
          {(source.driveFolderUrl || source.driveFileUrl) && (
            <a
              href={(source.driveFolderUrl ?? source.driveFileUrl)!}
              target="_blank"
              rel="noreferrer"
              className="btn mt-4 bg-white/10 text-sm text-white ring-1 ring-white/15 hover:bg-white/20"
            >
              <FolderOpen className="size-4" /> {source.driveFolderUrl ? "Open folder in Google Drive" : "Open JSON file in Google Drive"}
            </a>
          )}
          <div className="mt-5 grid gap-3 sm:grid-cols-2">
            <MiniLink icon={FileSpreadsheet} label="CSV link · Excel / Power BI" url={csvLink} />
            <MiniLink icon={Info} label="Status link · last success & errors" url={metaLink} />
          </div>
          <p className="mt-5 text-xs text-slate-400">
            Anyone with the link can read the data — treat it like a password. Cached 60 s · headers <code>X-Cache-Fetched-At</code>, <code>X-Cache-Age-Seconds</code>.
          </p>
        </div>
      </section>

      {source.health === "pending" && (
        <div className="flex items-center gap-3 rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-800 ring-1 ring-amber-200 ring-inset">
          <Spinner /> Waiting for the first successful fetch — this page updates every 3 min (or click Refresh now).
        </div>
      )}
      {source.lastError && <ErrorBox message={`Last fetch failed: ${source.lastError} — the link keeps serving the last good data.`} />}

      <section className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <InfoCard icon={Clock} label="Last success" value={timeAgo(source.lastSuccessAt, now)} hint={formatDateTime(source.lastSuccessAt)} />
        <InfoCard
          icon={Timer}
          label="Refresh schedule"
          value={`Every ${source.intervalMin} min`}
          hint={
            source.status === "paused"
              ? "Paused"
              : source.schedule && !source.inWindow && source.nextWindowAt
                ? `${source.scheduleText} · off-hours, resumes ${new Date(source.nextWindowAt).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })}`
                : source.scheduleText
          }
        />
        <InfoCard icon={Gauge} label="Apps Script time" value={formatMs(source.lastDurationMs)} hint="Your link answers in ms" />
        <InfoCard
          icon={HardDrive}
          label="Response size"
          value={formatBytes(source.lastSizeBytes)}
          hint={(source.lastSizeBytes ?? 0) > 5 * 1024 * 1024 ? "⚠️ Over 5 MB" : source.driveFileUrl ? "Stored in Google Drive" : "Stored in MongoDB"}
        />
      </section>

      {/* Logs */}
      <section className="card overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-5 py-4">
          <div>
            <h2 className="font-semibold text-slate-900">Fetch history</h2>
            <p className="text-xs text-slate-500">Last 50 fetches · kept for 7 days</p>
          </div>
          {logs && logs.length > 0 && (
            <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-600">
              {Math.round((okCount / logs.length) * 100)}% success
            </span>
          )}
        </div>
        {logs === null ? (
          <div className="space-y-3 p-5">
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} className="h-5 w-full" />
            ))}
          </div>
        ) : logs.length === 0 ? (
          <p className="px-5 py-12 text-center text-sm text-slate-500">No fetches yet.</p>
        ) : (
          <div className="max-h-[28rem] overflow-auto">
            <table className="min-w-full text-sm">
              <thead className="sticky top-0 z-10 bg-slate-50/95 text-left text-xs font-medium tracking-wide text-slate-500 uppercase backdrop-blur">
                <tr>
                  <th className="px-5 py-2.5">Time</th>
                  <th className="px-5 py-2.5">Result</th>
                  <th className="px-5 py-2.5">Duration</th>
                  <th className="px-5 py-2.5">Size</th>
                  <th className="px-5 py-2.5">Error</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {logs.map((l, i) => (
                  <tr key={i} className="hover:bg-slate-50/60">
                    <td className="px-5 py-2.5 whitespace-nowrap text-slate-600" title={formatDateTime(l.at)}>
                      {timeAgo(l.at, now)}
                      <span className="ml-2 text-xs text-slate-400">{new Date(l.at).toLocaleTimeString()}</span>
                    </td>
                    <td className="px-5 py-2.5">
                      <StatusBadge health={l.ok ? "ok" : "error"} label={l.ok ? "OK" : "Error"} />
                    </td>
                    <td className="px-5 py-2.5 whitespace-nowrap text-slate-600">{formatMs(l.durationMs)}</td>
                    <td className="px-5 py-2.5 whitespace-nowrap text-slate-600">{formatBytes(l.sizeBytes)}</td>
                    <td className="max-w-md px-5 py-2.5 break-words text-red-600">{l.error}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Snippets */}
      <section className="card p-5 sm:p-6">
        <h2 className="font-semibold text-slate-900">Connect your dashboard</h2>
        <p className="mt-1 text-sm text-slate-500">Copy-ready snippets with your link already filled in.</p>
        <div className="mt-4 inline-flex rounded-xl bg-slate-100 p-1">
          {(
            [
              ["powerbi", "Power BI", ChartColumn],
              ["excel", "Excel", FileSpreadsheet],
              ["js", "JavaScript", Braces],
            ] as const
          ).map(([key, label, Icon]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-medium transition-all ${
                tab === key ? "bg-white text-slate-900 shadow-sm" : "text-slate-500 hover:text-slate-800"
              }`}
            >
              <Icon className="size-4" /> {label}
            </button>
          ))}
        </div>
        <div className="mt-4 space-y-3">
          {tab === "powerbi" && (
            <>
              <Steps items={["Get Data → Web", "Paste the JSON link → OK", "Convert → To Table → expand columns"]} />
              <p className="text-sm text-slate-500">Or Get Data → Blank query → Advanced Editor:</p>
              <CodeBlock code={powerQueryJson(link)} />
            </>
          )}
          {tab === "excel" && (
            <>
              <Steps items={["Data → From Web", "Paste the CSV link → OK", "Load"]} />
              <p className="text-sm text-slate-500">Or Data → Get Data → Blank Query → Advanced Editor:</p>
              <CodeBlock code={powerQueryCsv(csvLink)} />
            </>
          )}
          {tab === "js" && (
            <>
              <p className="text-sm text-slate-500">Works from React, Next.js, Looker Studio connectors or any browser — CORS is open.</p>
              <CodeBlock code={jsSnippet(link)} />
            </>
          )}
        </div>
      </section>
    </div>
  );
}

function MiniLink({ icon: Icon, label, url }: { icon: ComponentType<{ className?: string }>; label: string; url: string }) {
  return (
    <div className="rounded-xl bg-white/5 p-3 ring-1 ring-white/10">
      <p className="mb-2 flex items-center gap-1.5 text-xs font-medium text-slate-300">
        <Icon className="size-3.5" /> {label}
      </p>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate text-xs text-slate-200">{url}</code>
        <CopyButton text={url} label="Copy" iconOnly className="inline-flex size-8 items-center justify-center rounded-lg text-slate-300 hover:bg-white/10 hover:text-white" />
      </div>
    </div>
  );
}

function InfoCard({ icon: Icon, label, value, hint }: { icon: ComponentType<{ className?: string }>; label: string; value: string; hint?: string }) {
  return (
    <div className="card p-5">
      <div className="flex items-center gap-2 text-sm text-slate-500">
        <Icon className="size-4 text-indigo-500" /> {label}
      </div>
      <p className="mt-2 text-xl font-semibold tracking-tight text-slate-900">{value}</p>
      {hint && <p className="mt-0.5 truncate text-xs text-slate-400">{hint}</p>}
    </div>
  );
}

function Steps({ items }: { items: string[] }) {
  return (
    <ol className="flex flex-wrap gap-2">
      {items.map((t, i) => (
        <li key={t} className="flex items-center gap-2 rounded-xl bg-indigo-50 px-3 py-1.5 text-sm text-indigo-900">
          <span className="flex size-5 items-center justify-center rounded-full bg-indigo-600 text-[11px] font-semibold text-white">{i + 1}</span>
          {t}
        </li>
      ))}
    </ol>
  );
}

const powerQueryJson = (url: string) => `let
    Source = Json.Document(Web.Contents("${url}")),
    // If the JSON is a list of objects:
    Table = Table.FromRecords(Source)
in
    Table`;

const powerQueryCsv = (url: string) => `let
    Source = Csv.Document(Web.Contents("${url}"), [Delimiter = ",", Encoding = 65001, QuoteStyle = QuoteStyle.Csv]),
    Promoted = Table.PromoteHeaders(Source, [PromoteAllScalars = true])
in
    Promoted`;

const jsSnippet = (url: string) => `const res = await fetch("${url}");
if (!res.ok) throw new Error(\`Cache error \${res.status}\`);
const data = await res.json();
console.log("fetched at", res.headers.get("X-Cache-Fetched-At"), "age (s)", res.headers.get("X-Cache-Age-Seconds"));`;
