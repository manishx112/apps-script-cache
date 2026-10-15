export type Health = "ok" | "error" | "paused" | "pending";

export interface Source {
  id: string;
  name: string;
  scriptUrl: string;
  intervalMin: number;
  token: string;
  status: "active" | "paused";
  health: Health;
  lastFetchedAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  lastDurationMs: number | null;
  lastSizeBytes: number | null;
  createdAt: string;
}

export interface Preview {
  kind: "objects" | "arrays" | "values" | "object" | "scalar";
  arrayPath: string | null;
  rowCount: number | null;
  columns: string[];
  rows: string[][];
}

export type TestResult =
  | { ok: true; durationMs: number; sizeBytes: number; large: boolean; preview: Preview }
  | { ok: false; durationMs: number; sizeBytes: number | null; error: string };

export interface RefreshResult {
  ok: boolean;
  durationMs: number;
  sizeBytes: number | null;
  error: string | null;
}

export interface FetchLog {
  at: string;
  ok: boolean;
  durationMs: number;
  sizeBytes: number | null;
  error: string | null;
}

export const INTERVALS = [5, 10, 15, 30, 60];

// Same rule as the Worker (worker/src/fetcher.ts).
export const SCRIPT_URL_RE = /^https:\/\/script\.google\.com\/(?:a\/macros\/[^/?#]+\/|macros\/(?:a\/[^/?#]+\/)?)s\/[A-Za-z0-9_-]{10,}\/exec(?:\?[^#]*)?$/;

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError("Network error — check your connection.", 0);
  }
  const data = await res.json().catch(() => null);
  if (res.status === 401 && path !== "/api/login") window.dispatchEvent(new Event("auth:expired"));
  if (!res.ok) throw new ApiError(data?.error ?? `Request failed (${res.status})`, res.status);
  return data as T;
}

export const api = {
  session: () => request<{ authenticated: boolean }>("GET", "/api/session"),
  login: (password: string) => request<{ ok: true }>("POST", "/api/login", { password }),
  logout: () => request<{ ok: true }>("POST", "/api/logout"),
  listSources: () => request<{ sources: Source[] }>("GET", "/api/sources"),
  getSource: (id: string) => request<{ source: Source }>("GET", `/api/sources/${id}`),
  createSource: (input: { name: string; scriptUrl: string; intervalMin: number }) => request<{ source: Source }>("POST", "/api/sources", input),
  updateSource: (id: string, patch: Partial<Pick<Source, "name" | "scriptUrl" | "intervalMin" | "status">>) =>
    request<{ source: Source }>("PATCH", `/api/sources/${id}`, patch),
  deleteSource: (id: string) => request<{ ok: true }>("DELETE", `/api/sources/${id}`),
  testUrl: (scriptUrl: string) => request<TestResult>("POST", "/api/sources/test", { scriptUrl }),
  refresh: (id: string) => request<{ result: RefreshResult; source: Source }>("POST", `/api/sources/${id}/refresh`),
  rotateToken: (id: string) => request<{ source: Source }>("POST", `/api/sources/${id}/rotate-token`),
  logs: (id: string) => request<{ logs: FetchLog[] }>("GET", `/api/sources/${id}/logs`),
};

export function dataUrl(token: string, csv = false): string {
  return `${window.location.origin}/d/${token}${csv ? "?format=csv" : ""}`;
}
