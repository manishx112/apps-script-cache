// Fetches an Apps Script web app and validates that it returned JSON.

// Accepts /macros/s/…, /macros/a/<domain>/s/… and Workspace's /a/macros/<domain>/s/….
export const SCRIPT_URL_RE = /^https:\/\/script\.google\.com\/(?:a\/macros\/[^/?#]+\/|macros\/(?:a\/[^/?#]+\/)?)s\/[A-Za-z0-9_-]{10,}\/exec(?:\?[^#]*)?$/;

export function isScriptUrl(url: unknown): url is string {
  return typeof url === "string" && url.length <= 2048 && SCRIPT_URL_RE.test(url.trim());
}

export type FetchOutcome =
  | { ok: true; durationMs: number; sizeBytes: number; text: string; data: unknown }
  | { ok: false; durationMs: number; sizeBytes: number | null; error: string };

// Google serves Apps Script differently to non-browser clients, so ask the way Chrome does.
const BROWSER_HEADERS: Record<string, string> = {
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  accept: "application/json,text/html;q=0.9,*/*;q=0.8",
  "accept-language": "en-US,en;q=0.9",
  "cache-control": "no-cache",
};
const MAX_REDIRECTS = 6;
/** Temporary-looking failures worth one more try (Google's echo step sometimes 404s). */
const RETRYABLE = new Set([404, 408, 429, 500, 502, 503, 504]);
const MIN_TIME_FOR_RETRY_MS = 15_000;

interface Attempt {
  res: Response | null;
  /** e.g. ["script.google.com 302", "script.googleusercontent.com 404"] */
  hops: string[];
  error?: string;
}

/**
 * One request chain, following redirects by hand like a browser: same headers on every hop and
 * cookies set by Google carried forward (/exec → 302 → script.googleusercontent.com/macros/echo).
 */
async function attempt(url: string, deadline: number): Promise<Attempt> {
  const hops: string[] = [];
  const cookies = new Map<string, string>();
  let current = url;
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { res: null, hops, error: "timeout" };
    const headers = new Headers(BROWSER_HEADERS);
    if (cookies.size) headers.set("cookie", [...cookies].map(([k, v]) => `${k}=${v}`).join("; "));
    let res: Response;
    try {
      res = await fetch(current, { redirect: "manual", headers, signal: AbortSignal.timeout(remaining) });
    } catch (err) {
      const name = (err as Error)?.name;
      return { res: null, hops, error: name === "TimeoutError" || name === "AbortError" ? "timeout" : `Network error: ${(err as Error)?.message ?? err}` };
    }
    const host = new URL(current).host;
    hops.push(`${host} ${res.status}`);
    for (const c of res.headers.getSetCookie?.() ?? []) {
      const [pair] = c.split(";");
      const eq = pair.indexOf("=");
      if (eq > 0) cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      await res.body?.cancel();
      current = new URL(location, current).toString();
      continue;
    }
    return { res, hops };
  }
  return { res: null, hops, error: "Too many redirects." };
}

export async function fetchScript(url: string, timeoutMs: number): Promise<FetchOutcome> {
  const started = Date.now();
  const deadline = started + timeoutMs;
  const elapsed = () => Date.now() - started;

  let a = await attempt(url, deadline);
  let retried = false;
  // One retry for transient Google errors, if enough time is left for the script to run again.
  if (a.res && RETRYABLE.has(a.res.status) && deadline - Date.now() > MIN_TIME_FOR_RETRY_MS) {
    console.log(`fetch: ${a.hops.join(" → ")}; retrying once`);
    await a.res.body?.cancel();
    a = await attempt(url, deadline);
    retried = true;
  }
  const retryNote = retried ? " (after 1 automatic retry)" : "";

  if (!a.res) {
    const error = a.error === "timeout" ? `Timed out after ${Math.round(timeoutMs / 1000)} s waiting for Apps Script${retryNote}.` : `${a.error}${retryNote}`;
    return { ok: false, durationMs: elapsed(), sizeBytes: null, error };
  }
  const res = a.res;

  let buf: ArrayBuffer;
  try {
    buf = await res.arrayBuffer();
  } catch (err) {
    return { ok: false, durationMs: elapsed(), sizeBytes: null, error: `Failed to read the response: ${(err as Error)?.message}` };
  }
  const durationMs = elapsed();
  const sizeBytes = buf.byteLength;
  const text = new TextDecoder().decode(buf);

  if (!res.ok) {
    const where = a.hops.length > 1 ? ` at ${a.hops[a.hops.length - 1].split(" ")[0]}` : "";
    return { ok: false, durationMs, sizeBytes, error: `Apps Script returned HTTP ${res.status}${where}${describeHtml(text)}${retryNote}` };
  }
  const trimmed = text.trimStart();
  if (trimmed.startsWith("<")) {
    const login = /accounts\.google\.com|ServiceLogin|Sign in/i.test(text);
    return {
      ok: false,
      durationMs,
      sizeBytes,
      error: login
        ? "Got a Google sign-in page instead of JSON. Deploy the web app with “Execute as: Me” and “Who has access: Anyone”."
        : `Got an HTML page instead of JSON${describeHtml(text)}. Make sure doGet() returns ContentService…setMimeType(JSON).`,
    };
  }
  if (!trimmed) return { ok: false, durationMs, sizeBytes, error: "Apps Script returned an empty response." };
  try {
    return { ok: true, durationMs, sizeBytes, text, data: JSON.parse(text) };
  } catch {
    const sample = trimmed.slice(0, 80).replace(/\s+/g, " ");
    return { ok: false, durationMs, sizeBytes, error: `Response is not valid JSON (starts with: “${sample}”).` };
  }
}

/** Pulls a short human hint out of a Google error page, e.g. “Script function not found: doGet”. */
function describeHtml(html: string): string {
  const m = /<div[^>]*>([^<]{5,200})<\/div>/i.exec(html) ?? /<title>([^<]{3,120})<\/title>/i.exec(html);
  return m ? ` (${m[1].trim()})` : "";
}
