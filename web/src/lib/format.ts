import { useEffect, useState } from "react";

export function timeAgo(iso: string | null, now: number): string {
  if (!iso) return "never";
  const s = Math.round((now - Date.parse(iso)) / 1000);
  if (s < 0) return "just now";
  if (s < 45) return "just now";
  if (s < 90) return "1 min ago";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return `${d} day${d === 1 ? "" : "s"} ago`;
}

export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export function formatMs(n: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return n < 1000 ? `${n} ms` : `${(n / 1000).toFixed(1)} s`;
}

export function formatDateTime(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : "—";
}

/** Re-renders every `ms` so relative times ("3 min ago") stay current. */
export function useNow(ms = 15_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

/** Calls `fn` now and every `ms` while the tab is visible. */
export function usePolling(fn: () => void, ms: number): void {
  useEffect(() => {
    fn();
    const t = setInterval(() => {
      if (document.visibilityState === "visible") fn();
    }, ms);
    const onVisible = () => document.visibilityState === "visible" && fn();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(t);
      document.removeEventListener("visibilitychange", onVisible);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ms]);
}

export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  const ta = document.createElement("textarea");
  ta.value = text;
  document.body.appendChild(ta);
  ta.select();
  document.execCommand("copy");
  ta.remove();
}
