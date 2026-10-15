import { Check, CircleAlert, Copy, Loader2, Sparkles } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { Health, Preview } from "../api";
import { copyText } from "../lib/format";

export function Spinner({ className = "size-4" }: { className?: string }) {
  return <Loader2 className={`animate-spin ${className}`} aria-hidden />;
}

export function Logo({ className = "size-8" }: { className?: string }) {
  return (
    <span className={`relative inline-flex items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 via-violet-500 to-fuchsia-500 shadow-md shadow-indigo-500/30 ${className}`}>
      <svg viewBox="0 0 24 24" className="size-[55%] fill-white" aria-hidden>
        <path d="M13.5 2 4 14h6.5L9.5 22 20 9.5h-6.5z" />
      </svg>
    </span>
  );
}

const BADGE: Record<Health, { label: string; cls: string; dot: string }> = {
  ok: { label: "Healthy", cls: "bg-emerald-50 text-emerald-700 ring-emerald-600/15", dot: "bg-emerald-500" },
  error: { label: "Error", cls: "bg-red-50 text-red-700 ring-red-600/15", dot: "bg-red-500" },
  paused: { label: "Paused", cls: "bg-slate-100 text-slate-600 ring-slate-500/15", dot: "bg-slate-400" },
  pending: { label: "Waiting", cls: "bg-amber-50 text-amber-700 ring-amber-600/15", dot: "bg-amber-500" },
};

export function StatusBadge({ health, label }: { health: Health; label?: string }) {
  const b = BADGE[health];
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${b.cls}`}>
      <span className="relative flex size-1.5">
        {health === "ok" && <span className={`absolute inline-flex size-full animate-ping rounded-full opacity-60 ${b.dot}`} />}
        <span className={`relative inline-flex size-1.5 rounded-full ${b.dot}`} />
      </span>
      {label ?? b.label}
    </span>
  );
}

export function CopyButton({ text, label = "Copy", className = "btn-secondary", iconOnly = false }: { text: string; label?: string; className?: string; iconOnly?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={className}
      title={iconOnly ? label : undefined}
      aria-label={label}
      onClick={async () => {
        try {
          await copyText(text);
          setCopied(true);
          toast.success("Copied to clipboard");
          setTimeout(() => setCopied(false), 1500);
        } catch {
          toast.error("Could not copy — select the text and copy it manually.");
        }
      }}
    >
      {copied ? <Check className="size-4 text-emerald-600" /> : <Copy className="size-4" />}
      {!iconOnly && (copied ? "Copied" : label)}
    </button>
  );
}

export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="card relative overflow-hidden px-6 py-16 text-center">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(400px_200px_at_50%_0%,rgb(99_102_241/0.08),transparent)]" />
      <div className="relative mx-auto mb-4 flex size-14 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-500 text-white shadow-lg shadow-indigo-500/30">
        <Sparkles className="size-7" />
      </div>
      <h3 className="relative text-lg font-semibold text-slate-900">{title}</h3>
      {children && <div className="relative mx-auto mt-1.5 max-w-md text-sm text-slate-500">{children}</div>}
      {action && <div className="relative mt-6">{action}</div>}
    </div>
  );
}

export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex items-start gap-3 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700 ring-1 ring-red-200 ring-inset" role="alert">
      <CircleAlert className="mt-0.5 size-4 shrink-0" />
      <span className="flex-1 break-words">{message}</span>
      {onRetry && (
        <button className="shrink-0 font-medium underline underline-offset-2" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}

export function PreviewTable({ preview }: { preview: Preview }) {
  if (!preview.rows.length) return <p className="text-sm text-slate-500">The response is an empty list.</p>;
  return (
    <div className="overflow-x-auto rounded-xl ring-1 ring-slate-200">
      <table className="min-w-full divide-y divide-slate-200 text-sm">
        <thead className="bg-slate-50/80">
          <tr>
            {preview.columns.map((c, i) => (
              <th key={i} className="px-3 py-2 text-left text-xs font-semibold whitespace-nowrap text-slate-600">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100 bg-white">
          {preview.rows.map((r, i) => (
            <tr key={i} className="hover:bg-slate-50/60">
              {r.map((c, j) => (
                <td key={j} className="max-w-xs truncate px-3 py-2 text-slate-700" title={c}>
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function CodeBlock({ code }: { code: string }) {
  return (
    <div className="group relative overflow-hidden rounded-xl bg-slate-950 ring-1 ring-slate-800">
      <div className="absolute top-2 right-2">
        <CopyButton text={code} label="Copy code" className="btn bg-white/10 px-2.5 py-1 text-xs text-slate-200 hover:bg-white/20" />
      </div>
      <pre className="overflow-x-auto p-4 pr-24 font-mono text-[12.5px] leading-relaxed text-slate-200">{code}</pre>
    </div>
  );
}

export function Skeleton({ className }: { className: string }) {
  return <div className={`skeleton ${className}`} />;
}

interface ConfirmOptions {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  danger?: boolean;
}

/** `const [confirm, dialog] = useConfirm()` → `if (await confirm({...})) …`, render `{dialog}` once. */
export function useConfirm(): [(o: ConfirmOptions) => Promise<boolean>, ReactNode] {
  const [state, setState] = useState<(ConfirmOptions & { resolve: (v: boolean) => void }) | null>(null);
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    if (state) ref.current?.showModal();
    else ref.current?.close();
  }, [state]);

  const confirm = useCallback((o: ConfirmOptions) => new Promise<boolean>((resolve) => setState({ ...o, resolve })), []);
  const finish = (v: boolean) => {
    state?.resolve(v);
    setState(null);
  };

  const dialog = (
    <dialog
      ref={ref}
      onCancel={(e) => {
        e.preventDefault();
        finish(false);
      }}
      onClick={(e) => e.target === ref.current && finish(false)}
      className="m-auto w-[calc(100%-2rem)] max-w-md rounded-2xl p-0 shadow-2xl backdrop:bg-slate-950/40 backdrop:backdrop-blur-sm"
    >
      {state && (
        <div className="p-6">
          <div className={`mb-4 flex size-11 items-center justify-center rounded-xl ${state.danger ? "bg-red-50 text-red-600" : "bg-indigo-50 text-indigo-600"}`}>
            <CircleAlert className="size-5" />
          </div>
          <h2 className="text-lg font-semibold text-slate-900">{state.title}</h2>
          <div className="mt-2 text-sm leading-relaxed text-slate-600">{state.body}</div>
          <div className="mt-6 flex justify-end gap-2">
            <button className="btn-secondary" onClick={() => finish(false)}>
              Cancel
            </button>
            <button className={state.danger ? "btn-danger" : "btn-primary"} onClick={() => finish(true)} autoFocus>
              {state.confirmLabel}
            </button>
          </div>
        </div>
      )}
    </dialog>
  );
  return [confirm, dialog];
}
