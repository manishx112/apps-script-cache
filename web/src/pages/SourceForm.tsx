import { ArrowLeft, CheckCircle2, FlaskConical, Save, TriangleAlert, XCircle } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { toast } from "sonner";
import { api, ApiError, INTERVALS, SCRIPT_URL_RE, type TestResult } from "../api";
import { ErrorBox, PreviewTable, Spinner } from "../components/ui";
import { formatBytes, formatMs } from "../lib/format";

export default function SourceForm() {
  const { id } = useParams();
  const editing = !!id;
  const navigate = useNavigate();

  const [name, setName] = useState("");
  const [scriptUrl, setScriptUrl] = useState("");
  const [intervalMin, setIntervalMin] = useState(15);
  const [loading, setLoading] = useState(editing);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<(TestResult & { url: string }) | null>(null);

  useEffect(() => {
    if (!id) return;
    api
      .getSource(id)
      .then(({ source }) => {
        setName(source.name);
        setScriptUrl(source.scriptUrl);
        setIntervalMin(source.intervalMin);
      })
      .catch((err) => setLoadError(err instanceof ApiError ? err.message : "Could not load the source."))
      .finally(() => setLoading(false));
  }, [id]);

  const url = scriptUrl.trim();
  const urlValid = SCRIPT_URL_RE.test(url);
  const showUrlError = url.length > 0 && !urlValid;
  const canSave = urlValid && name.trim().length > 0 && !saving;

  async function runTest() {
    setTesting(true);
    setTest(null);
    try {
      const r = await api.testUrl(url);
      setTest({ ...r, url });
      if (r.ok) toast.success(`Got valid JSON in ${formatMs(r.durationMs)}`);
      else toast.error("The URL did not return valid JSON.");
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Test failed.");
    } finally {
      setTesting(false);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!canSave) return;
    setSaving(true);
    setSaveError(null);
    try {
      const input = { name: name.trim(), scriptUrl: url, intervalMin };
      if (editing) {
        await api.updateSource(id!, input);
        toast.success("Changes saved.");
        navigate(`/sources/${id}`);
      } else {
        const { source } = await api.createSource(input);
        toast.success("Source added — the first fetch is running now.");
        navigate(`/sources/${source.id}`);
      }
    } catch (err) {
      setSaveError(err instanceof ApiError ? err.message : "Could not save.");
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div className="card flex items-center justify-center gap-2 py-16 text-sm text-slate-500">
        <Spinner /> Loading…
      </div>
    );
  }
  if (loadError) return <ErrorBox message={loadError} />;

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <div>
        <Link to={editing ? `/sources/${id}` : "/"} className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-slate-900">
          <ArrowLeft className="size-4" /> Back
        </Link>
        <h1 className="mt-3 text-3xl font-semibold tracking-tight text-slate-900">{editing ? "Edit source" : "Add source"}</h1>
        {!editing && <p className="text-sm text-slate-500">The Worker will fetch this URL on schedule and serve the latest JSON instantly.</p>}
      </div>

      <form onSubmit={submit} className="card space-y-6 p-6 sm:p-8">
        <div>
          <label htmlFor="name" className="label">
            Name
          </label>
          <input id="name" className="input" placeholder="e.g. Sales dashboard" maxLength={100} value={name} onChange={(e) => setName(e.target.value)} required />
        </div>

        <div>
          <label htmlFor="url" className="label">
            Apps Script URL
          </label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              id="url"
              className={`input font-mono ${showUrlError ? "border-red-400 focus:border-red-500 focus:ring-red-500/20" : ""}`}
              placeholder="https://script.google.com/macros/s/…/exec"
              value={scriptUrl}
              onChange={(e) => setScriptUrl(e.target.value)}
              spellCheck={false}
              required
            />
            <button type="button" className="btn-secondary shrink-0" onClick={runTest} disabled={!urlValid || testing}>
              {testing ? <Spinner /> : <FlaskConical className="size-4" />}
              {testing ? "Testing…" : "Test URL"}
            </button>
          </div>
          {showUrlError ? (
            <p className="mt-1.5 text-xs text-red-600">Must look like https://script.google.com/macros/s/&lt;deployment-id&gt;/exec</p>
          ) : (
            <p className="mt-1.5 text-xs text-slate-500">Deploy → Web app, with “Who has access: Anyone”. Query parameters are allowed.</p>
          )}
        </div>

        {testing && (
          <div className="flex items-center gap-2 rounded-xl bg-indigo-50 px-4 py-3 text-sm text-indigo-800 ring-1 ring-indigo-100 ring-inset">
            <Spinner /> Calling Apps Script — this can take several seconds…
          </div>
        )}
        {test && test.url === url && <TestPanel test={test} />}

        <div>
          <label htmlFor="interval" className="label">
            Refresh interval
          </label>
          <select id="interval" className="input sm:w-56" value={intervalMin} onChange={(e) => setIntervalMin(Number(e.target.value))}>
            {INTERVALS.map((m) => (
              <option key={m} value={m}>
                Every {m} minutes
              </option>
            ))}
          </select>
        </div>

        {saveError && <ErrorBox message={saveError} />}

        <div className="flex flex-wrap items-center justify-end gap-2 border-t border-slate-100 pt-5">
          <Link to={editing ? `/sources/${id}` : "/"} className="btn-secondary">
            Cancel
          </Link>
          <button type="submit" className="btn-primary" disabled={!canSave}>
            {saving ? <Spinner /> : <Save className="size-4" />}
            {editing ? "Save changes" : "Save source"}
          </button>
        </div>
      </form>
    </div>
  );
}

function TestPanel({ test }: { test: TestResult }) {
  if (!test.ok) {
    return (
      <div className="rounded-2xl bg-red-50 p-5 text-sm ring-1 ring-red-200 ring-inset">
        <p className="flex items-center gap-2 font-semibold text-red-800"><XCircle className="size-4" /> Not usable yet</p>
        <p className="mt-1 break-words text-red-700">{test.error}</p>
        <p className="mt-2 text-xs text-red-600">
          After {formatMs(test.durationMs)}
          {test.sizeBytes !== null && ` · ${formatBytes(test.sizeBytes)}`}
        </p>
      </div>
    );
  }
  const p = test.preview;
  return (
    <div className="animate-fade-in space-y-4 rounded-2xl bg-gradient-to-b from-emerald-50 to-white p-5 ring-1 ring-emerald-200 ring-inset">
      <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
        <span className="flex items-center gap-1.5 font-semibold text-emerald-800"><CheckCircle2 className="size-4" /> Valid JSON</span>
        <span className="text-slate-600">
          Response time <b>{formatMs(test.durationMs)}</b>
        </span>
        <span className="text-slate-600">
          Size <b>{formatBytes(test.sizeBytes)}</b>
        </span>
        {p.rowCount !== null && (
          <span className="text-slate-600">
            Rows <b>{p.rowCount.toLocaleString()}</b>
            {p.arrayPath && <> (from “{p.arrayPath}”)</>}
          </span>
        )}
      </div>
      {test.large && (
        <p className="flex gap-2 rounded-xl bg-amber-50 px-3 py-2.5 text-sm text-amber-800 ring-1 ring-amber-200 ring-inset">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" /> This response is over 5 MB. It will work (large responses are stored in chunks), but refreshes use more CPU and dashboards download more data. Consider
          returning fewer columns or rows.
        </p>
      )}
      <div>
        <p className="mb-1.5 text-xs font-medium text-slate-500">{p.rowCount !== null ? "First 5 rows" : "Preview"}</p>
        <PreviewTable preview={p} />
      </div>
    </div>
  );
}
