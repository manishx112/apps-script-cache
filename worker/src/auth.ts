// Admin auth: one password (ADMIN_KEY) → HttpOnly session cookie signed with SESSION_SECRET (HMAC-SHA256).

import { HttpError, json, readJson } from "./http";

const COOKIE = "asc_session";
const SESSION_SECONDS = 7 * 24 * 3600;
const enc = new TextEncoder();

function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = "";
  for (const b of arr) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function sha256(text: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", enc.encode(text));
}

function sessionSecret(env: Env): string {
  const s = env.SESSION_SECRET?.trim();
  if (!s || s.length < 32) throw new HttpError(500, "SESSION_SECRET is not set. Run: npm run secret:session");
  return s;
}

/** Short fingerprint of ADMIN_KEY: changing the password invalidates every existing session. */
async function keyVersion(env: Env): Promise<string> {
  return b64url(await sha256(`kv:${env.ADMIN_KEY.trim()}`)).slice(0, 12);
}

async function createSession(env: Env): Promise<string> {
  const payload = b64url(enc.encode(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + SESSION_SECONDS, kv: await keyVersion(env) })));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(sessionSecret(env)), enc.encode(payload));
  return `${payload}.${b64url(sig)}`;
}

function readCookie(req: Request, name: string): string | null {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}

export async function isAuthenticated(req: Request, env: Env): Promise<boolean> {
  const raw = readCookie(req, COOKIE);
  if (!raw || !env.ADMIN_KEY) return false;
  const [payload, sig] = raw.split(".");
  if (!payload || !sig) return false;
  try {
    const valid = await crypto.subtle.verify("HMAC", await hmacKey(sessionSecret(env)), fromB64url(sig), enc.encode(payload));
    if (!valid) return false;
    const { exp, kv } = JSON.parse(new TextDecoder().decode(fromB64url(payload))) as { exp: number; kv: string };
    return exp > Date.now() / 1000 && kv === (await keyVersion(env));
  } catch {
    return false;
  }
}

function cookie(value: string, maxAge: number, secure: boolean): string {
  return `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

// Brute-force brake: per isolate, per IP. Each failure also waits a moment before answering.
const failures = new Map<string, { count: number; until: number }>();
const MAX_FAILURES = 8;
const LOCK_MS = 15 * 60_000;

export async function login(req: Request, env: Env): Promise<Response> {
  const adminKey = env.ADMIN_KEY?.trim();
  if (!adminKey) throw new HttpError(500, "ADMIN_KEY is not set. Run: npm run secret:admin-key");
  const ip = req.headers.get("cf-connecting-ip") ?? "local";
  const f = failures.get(ip);
  if (f && f.count >= MAX_FAILURES && f.until > Date.now()) {
    throw new HttpError(429, "Too many failed attempts. Try again in 15 minutes.");
  }

  const { password } = await readJson<{ password?: unknown }>(req);
  const given = typeof password === "string" ? password.trim() : "";
  // Compare digests in constant time (equal length regardless of input).
  const ok = given.length > 0 && crypto.subtle.timingSafeEqual(await sha256(given), await sha256(adminKey));
  if (!ok) {
    const next = { count: (f && f.until > Date.now() ? f.count : 0) + 1, until: Date.now() + LOCK_MS };
    failures.set(ip, next);
    await new Promise((r) => setTimeout(r, 400 * Math.min(next.count, 5)));
    throw new HttpError(401, "Wrong password.");
  }
  failures.delete(ip);
  const secure = new URL(req.url).protocol === "https:" || !isLocal(req);
  return json({ ok: true }, { headers: { "set-cookie": cookie(await createSession(env), SESSION_SECONDS, secure) } });
}

export function logout(req: Request): Response {
  return json({ ok: true }, { headers: { "set-cookie": cookie("", 0, !isLocal(req)) } });
}

function isLocal(req: Request): boolean {
  const host = new URL(req.url).hostname;
  return host === "localhost" || host === "127.0.0.1";
}

/** Blocks cross-site writes (in addition to SameSite=Strict). */
export function checkOrigin(req: Request): void {
  if (req.method === "GET" || req.method === "HEAD") return;
  const origin = req.headers.get("origin");
  if (!origin) return;
  const self = new URL(req.url);
  const o = new URL(origin);
  const localDev = ["localhost", "127.0.0.1"].includes(o.hostname) && ["localhost", "127.0.0.1"].includes(self.hostname);
  if (o.host !== self.host && !localDev) throw new HttpError(403, "Cross-site request blocked.");
}
