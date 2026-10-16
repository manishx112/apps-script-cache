// Google Drive storage for snapshots (free 15 GB). One folder ("Apps Script Cache") holds one
// `<source name>.json` file per source.
//
// Auth: OAuth refresh token for the owner's Google account (scope drive.file = only files this app
// created). Set by `npm run google:connect`, which also creates the root "Apps Script Cache" folder.

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const FILES = "https://www.googleapis.com/drive/v3/files";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const SIMPLE_UPLOAD_MAX = 5 * 1024 * 1024; // larger files use a resumable upload

export class DriveNotFound extends Error {}

export function driveEnabled(env: Env): boolean {
  return !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET && env.GOOGLE_REFRESH_TOKEN && env.GOOGLE_DRIVE_FOLDER_ID);
}

export function fileUrl(fileId: string): string {
  return `https://drive.google.com/file/d/${fileId}/view`;
}

/** Drive folder name for a source, e.g. "Sales dashboard". */
export function folderName(sourceName: string): string {
  return sourceName.replace(/[\\/:*?"<>|]+/g, "-").trim() || "source";
}

export function folderUrl(folderId: string): string {
  return `https://drive.google.com/drive/folders/${folderId}`;
}

/** Drive file name for a source, e.g. "Sales dashboard.json". */
export function jsonFileName(sourceName: string): string {
  return `${sourceName.replace(/[\\/:*?"<>|]+/g, "-").trim() || "source"}.json`;
}

// Access tokens live ~1 hour; keep one per isolate so most calls skip the token request.
let cached: { token: string; expires: number } | null = null;

async function accessToken(env: Env): Promise<string> {
  if (cached && cached.expires > Date.now() + 60_000) return cached.token;
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID!.trim(),
      client_secret: env.GOOGLE_CLIENT_SECRET!.trim(),
      refresh_token: env.GOOGLE_REFRESH_TOKEN!.trim(),
      grant_type: "refresh_token",
    }),
  });
  const data = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error?: string; error_description?: string };
  if (!res.ok || !data.access_token) {
    const hint = data.error === "invalid_grant" ? " — Google access expired or was removed; run `npm run google:connect` again." : "";
    throw new Error(`Google sign-in failed (${data.error ?? res.status}${data.error_description ? `: ${data.error_description}` : ""})${hint}`);
  }
  cached = { token: data.access_token, expires: Date.now() + (data.expires_in ?? 3600) * 1000 };
  return cached.token;
}

async function call(env: Env, url: string, init: RequestInit, what: string): Promise<Response> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${await accessToken(env)}`);
    const res = await fetch(url, { ...init, headers });
    if (res.status === 401 && attempt === 0) {
      cached = null; // token revoked/expired early: refresh once
      continue;
    }
    if (res.status === 404) throw new DriveNotFound(`Google Drive: ${what} not found.`);
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
      throw new Error(`Google Drive ${what} failed: HTTP ${res.status}${body?.error?.message ? ` — ${body.error.message}` : ""}`);
    }
    return res;
  }
  throw new Error(`Google Drive ${what} failed: not authorized.`);
}

export async function createFolder(env: Env, name: string, parentId: string): Promise<string> {
  const res = await call(
    env,
    `${FILES}?fields=id`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name, mimeType: FOLDER_MIME, parents: [parentId] }) },
    "create folder",
  );
  return ((await res.json()) as { id: string }).id;
}

/** Uploads `text`: overwrites `fileId` when given, otherwise creates `name` in `folderId`. Returns the file id. */
export async function writeJsonFile(env: Env, opts: { fileId: string | null; folderId: string; name: string; text: string; sizeBytes: number }): Promise<string> {
  const { folderId, text, sizeBytes } = opts;
  if (opts.fileId) {
    try {
      if (sizeBytes <= SIMPLE_UPLOAD_MAX) {
        await call(env, `${UPLOAD}/${opts.fileId}?uploadType=media&fields=id`, { method: "PATCH", headers: { "content-type": "application/json" }, body: text }, "update file");
      } else {
        await resumable(env, `${UPLOAD}/${opts.fileId}?uploadType=resumable`, "PATCH", {}, text);
      }
      return opts.fileId;
    } catch (err) {
      if (!(err instanceof DriveNotFound)) throw err; // file was deleted in Drive: create a new one below
    }
  }

  const metadata = { name: opts.name, mimeType: "application/json", parents: [folderId] };
  if (sizeBytes <= SIMPLE_UPLOAD_MAX) {
    const boundary = `asc${crypto.randomUUID().replace(/-/g, "")}`;
    const body =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\nContent-Type: application/json\r\n\r\n${text}\r\n--${boundary}--`;
    const res = await call(env, `${UPLOAD}?uploadType=multipart&fields=id`, { method: "POST", headers: { "content-type": `multipart/related; boundary=${boundary}` }, body }, "create file");
    return ((await res.json()) as { id: string }).id;
  }
  const res = await resumable(env, `${UPLOAD}?uploadType=resumable&fields=id`, "POST", metadata, text);
  return ((await res.json()) as { id: string }).id;
}

async function resumable(env: Env, url: string, method: "POST" | "PATCH", metadata: object, text: string): Promise<Response> {
  const start = await call(
    env,
    url,
    { method, headers: { "content-type": "application/json; charset=UTF-8", "x-upload-content-type": "application/json" }, body: JSON.stringify(metadata) },
    "start upload",
  );
  const location = start.headers.get("location");
  if (!location) throw new Error("Google Drive did not return an upload URL.");
  return call(env, location, { method: "PUT", headers: { "content-type": "application/json" }, body: text }, "upload");
}

export async function readJsonFile(env: Env, fileId: string): Promise<string> {
  const res = await call(env, `${FILES}/${fileId}?alt=media`, { method: "GET" }, "read file");
  return res.text();
}

export async function renameItem(env: Env, id: string, name: string): Promise<void> {
  await call(env, `${FILES}/${id}?fields=id`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) }, "rename");
}

/** Moves a file/folder from one parent folder to another (keeps its id). */
export async function moveItem(env: Env, id: string, toFolder: string, fromFolder: string): Promise<void> {
  await call(env, `${FILES}/${id}?addParents=${toFolder}&removeParents=${fromFolder}&fields=id`, { method: "PATCH", headers: { "content-type": "application/json" }, body: "{}" }, "move");
}

/** Moves to Drive's trash (recoverable for 30 days) rather than deleting permanently. */
export async function trashItem(env: Env, id: string): Promise<void> {
  await call(env, `${FILES}/${id}?fields=id`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ trashed: true }) }, "trash");
}
