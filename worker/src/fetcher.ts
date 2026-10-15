// Fetches an Apps Script web app and validates that it returned JSON.

// Accepts /macros/s/…, /macros/a/<domain>/s/… and Workspace's /a/macros/<domain>/s/….
export const SCRIPT_URL_RE = /^https:\/\/script\.google\.com\/(?:a\/macros\/[^/?#]+\/|macros\/(?:a\/[^/?#]+\/)?)s\/[A-Za-z0-9_-]{10,}\/exec(?:\?[^#]*)?$/;

export function isScriptUrl(url: unknown): url is string {
  return typeof url === "string" && url.length <= 2048 && SCRIPT_URL_RE.test(url.trim());
}

export type FetchOutcome =
  | { ok: true; durationMs: number; sizeBytes: number; text: string; data: unknown }
  | { ok: false; durationMs: number; sizeBytes: number | null; error: string };

export async function fetchScript(url: string, timeoutMs: number): Promise<FetchOutcome> {
  const started = Date.now();
  const elapsed = () => Date.now() - started;
  let res: Response;
  try {
    // /exec answers with a 302 to script.googleusercontent.com; fetch follows it.
    res = await fetch(url, {
      redirect: "follow",
      headers: { accept: "application/json, text/plain;q=0.9, */*;q=0.1", "user-agent": "apps-script-cache/1.0" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const name = (err as Error)?.name;
    const error =
      name === "TimeoutError" || name === "AbortError"
        ? `Timed out after ${Math.round(timeoutMs / 1000)} s waiting for Apps Script.`
        : `Network error: ${(err as Error)?.message ?? String(err)}`;
    return { ok: false, durationMs: elapsed(), sizeBytes: null, error };
  }

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
    return { ok: false, durationMs, sizeBytes, error: `Apps Script returned HTTP ${res.status}${describeHtml(text)}` };
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
