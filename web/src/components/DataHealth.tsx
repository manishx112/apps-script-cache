import { Brush, CheckCircle2, Database, RefreshCw, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { api, ApiError, type DataReport } from "../api";
import { formatBytes } from "../lib/format";
import { Spinner, useConfirm } from "./ui";

const ISSUE_LABELS: [keyof Omit<DataReport["issues"], "leftoverCollections">, string][] = [
  ["redundantSnapshots", "Old snapshot copies of sources now stored in Google Drive"],
  ["orphanSnapshots", "Snapshots of deleted sources"],
  ["orphanLogs", "Fetch logs of deleted sources"],
  ["orphanChunks", "Data pieces of deleted sources"],
  ["staleChunks", "Outdated data pieces of large responses"],
];

/** Dashboard card: MongoDB usage, redundant/orphaned data, one-click cleanup. Loads only on demand. */
export default function DataHealth() {
  const [report, setReport] = useState<DataReport | null>(null);
  const [busy, setBusy] = useState<"check" | "clean" | null>(null);
  const [confirm, dialog] = useConfirm();

  async function check() {
    setBusy("check");
    try {
      setReport((await api.dataReport()).report);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Could not check the database.");
    } finally {
      setBusy(null);
    }
  }

  async function clean() {
    if (!report) return;
    const ok = await confirm({
      title: "Clean up the database?",
      body: "Removes only redundant or orphaned data created by this app (listed in the card) and the leftover setup collections. Your sources, their links and the current data are not touched.",
      confirmLabel: "Clean up",
    });
    if (!ok) return;
    setBusy("clean");
    try {
      const r = await api.cleanUp();
      setReport(r.report);
      const removed = Object.values(r.removed).reduce((a, b) => a + b, 0);
      toast.success(`Removed ${removed.toLocaleString()} document${removed === 1 ? "" : "s"}${r.droppedCollections.length ? ` and ${r.droppedCollections.length} unused collection(s)` : ""}.`);
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Cleanup failed.");
    } finally {
      setBusy(null);
    }
  }

  const used = report ? report.storageSizeBytes + report.indexSizeBytes : 0;
  const pct = report ? Math.min(100, (used / report.quotaBytes) * 100) : 0;

  return (
    <section className="card p-5 sm:p-6">
      {dialog}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-xl bg-gradient-to-br from-sky-500 to-indigo-500 text-white shadow-sm">
            <Database className="size-5" />
          </div>
          <div>
            <h2 className="font-semibold text-slate-900">Database health</h2>
            <p className="text-sm text-slate-500">MongoDB usage, redundant and leftover data.</p>
          </div>
        </div>
        <div className="flex gap-2">
          <button className="btn-secondary" onClick={check} disabled={!!busy}>
            {busy === "check" ? <Spinner /> : <RefreshCw className="size-4" />} {report ? "Check again" : "Check database"}
          </button>
          {report && report.totalIssues > 0 && (
            <button className="btn-primary" onClick={clean} disabled={!!busy}>
              {busy === "clean" ? <Spinner /> : <Brush className="size-4" />} Clean up
            </button>
          )}
        </div>
      </div>

      {report && (
        <div className="mt-5 animate-fade-in space-y-5">
          <div>
            <div className="mb-1.5 flex justify-between text-sm">
              <span className="text-slate-600">
                Used <b className="text-slate-900">{formatBytes(used)}</b> of {formatBytes(report.quotaBytes)} free tier
              </span>
              <span className="text-slate-500">{pct < 0.1 ? "<0.1" : pct.toFixed(1)}%</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-slate-100">
              <div className={`h-full rounded-full ${pct > 80 ? "bg-red-500" : pct > 50 ? "bg-amber-500" : "bg-emerald-500"}`} style={{ width: `${Math.max(pct, 1)}%` }} />
            </div>
          </div>

          {report.totalIssues === 0 ? (
            <p className="flex items-center gap-2 rounded-xl bg-emerald-50 px-4 py-3 text-sm text-emerald-800 ring-1 ring-emerald-200 ring-inset">
              <CheckCircle2 className="size-4" /> Clean — no redundant, orphaned or leftover data.
            </p>
          ) : (
            <div className="rounded-xl bg-amber-50 px-4 py-3 text-sm text-amber-900 ring-1 ring-amber-200 ring-inset">
              <p className="mb-2 flex items-center gap-2 font-medium">
                <TriangleAlert className="size-4" /> Can be cleaned up
              </p>
              <ul className="space-y-1">
                {ISSUE_LABELS.filter(([k]) => report.issues[k] > 0).map(([k, label]) => (
                  <li key={k} className="flex justify-between gap-4">
                    <span>{label}</span>
                    <b>{report.issues[k].toLocaleString()}</b>
                  </li>
                ))}
                {report.issues.leftoverCollections.map((c) => (
                  <li key={c} className="flex justify-between gap-4">
                    <span>
                      Unused setup collection <code>{c}</code>
                    </span>
                    <b>drop</b>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="overflow-hidden rounded-xl ring-1 ring-slate-200">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50 text-left text-xs font-medium tracking-wide text-slate-500 uppercase">
                <tr>
                  <th className="px-4 py-2">Collection</th>
                  <th className="px-4 py-2 text-right">Documents</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {report.collections.map((c) => (
                  <tr key={c.name}>
                    <td className="px-4 py-2 font-mono text-xs text-slate-700">
                      {c.name}
                      {c.kind === "leftover" && <span className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 font-sans text-[10px] text-amber-800">unused</span>}
                      {c.kind === "other" && <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 font-sans text-[10px] text-slate-600">not from this app</span>}
                    </td>
                    <td className="px-4 py-2 text-right text-slate-600">{c.documents.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-slate-400">Fetch logs delete themselves after 7 days. Collections marked “not from this app” are never touched.</p>
        </div>
      )}
    </section>
  );
}
