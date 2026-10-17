export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function json(data: unknown, init: ResponseInit = {}): Response {
  const headers = new Headers(init.headers);
  if (!headers.has("content-type")) headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data), { ...init, headers });
}

export function errorJson(status: number, message: string, headers?: HeadersInit): Response {
  return json({ error: message }, { status, headers });
}

/** Removes secrets (and any user:pass@ in URLs) from text that may be shown or logged. */
export function redact(text: string, env: Env): string {
  let out = text;
  for (const secret of [env.ADMIN_KEY, env.SESSION_SECRET, env.GOOGLE_CLIENT_SECRET, env.GOOGLE_REFRESH_TOKEN]) {
    const v = secret?.trim();
    if (v && v.length >= 8) out = out.split(v).join("[secret]");
  }
  return out.replace(/\/\/[^/@\s]+@/g, "//[credentials]@");
}

export async function readJson<T = Record<string, unknown>>(req: Request, maxBytes = 16_384): Promise<T> {
  const type = req.headers.get("content-type") ?? "";
  if (!type.includes("application/json")) throw new HttpError(415, "Send a JSON body (Content-Type: application/json).");
  const text = await req.text();
  if (text.length > maxBytes) throw new HttpError(413, "Request body is too large.");
  try {
    const body = JSON.parse(text || "{}");
    if (body === null || typeof body !== "object" || Array.isArray(body)) throw new Error();
    return body as T;
  } catch {
    throw new HttpError(400, "Request body is not valid JSON.");
  }
}

export function intVar(value: string | undefined, fallback: number): number {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Run `fn` over `items` with at most `limit` in flight. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
