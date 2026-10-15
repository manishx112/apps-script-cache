#!/usr/bin/env node
// Interactive helper for the Worker's secrets. Nothing typed here is echoed, logged or written to disk
// (except into .dev.vars when --local is used, which is git-ignored).
//
//   node scripts/set-secret.mjs env          read .env, test MongoDB, upload all secrets (npm run secrets)
//   node scripts/set-secret.mjs mongodb      build MONGODB_URI from user + password, test the login, upload
//   node scripts/set-secret.mjs admin-key    set ADMIN_KEY (the dashboard password)
//   node scripts/set-secret.mjs session      generate a random SESSION_SECRET (cookie signing key)
//
// Options:
//   --local              write to .dev.vars (for `npm run dev`) instead of uploading to Cloudflare
//   --user <name>        MongoDB username (default: cache-proxy-worker)
//   --host <host>        Atlas SRV host (default: cache-cluster.iplzsxd.mongodb.net)
//   --allow-admin        accept a user with admin-level roles (not recommended)
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import dns from "node:dns";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_USER = "cache-proxy-worker";
const DEFAULT_HOST = "cache-cluster.iplzsxd.mongodb.net";
const DB_NAME = "cache_proxy";
const BROAD_ROLES = new Set(["atlasAdmin", "root", "readWriteAnyDatabase", "dbAdminAnyDatabase", "userAdminAnyDatabase", "clusterAdmin"]);

const args = process.argv.slice(2);
const command = args.find((a) => !a.startsWith("--"));
const flag = (name) => args.includes(`--${name}`);
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const local = flag("local");

const ok = (msg) => console.log(`\x1b[32m✔\x1b[0m ${msg}`);
const fail = (msg) => {
  console.error(`\x1b[31m✘\x1b[0m ${msg}`);
  process.exit(1);
};

/** Read a line from the terminal in raw mode. Hidden input echoes `*`; bracketed-paste markers are stripped. */
function ask(question, { hidden = false, fallback = "" } = {}) {
  const { stdin, stdout } = process;
  if (!stdin.isTTY) fail("Run this in an interactive terminal.");
  return new Promise((resolve) => {
    stdout.write(question);
    stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    stdin.resume();
    let value = "";
    const cleanup = () => {
      stdin.off("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
    };
    function onData(chunk) {
      const text = chunk.replace(/\x1b\[[0-9;]*[A-Za-z~]/g, "");
      for (const ch of text) {
        if (ch === "\r" || ch === "\n") {
          cleanup();
          stdout.write("\n");
          resolve(value || fallback);
          return;
        }
        if (ch === "\u0003") {
          cleanup();
          stdout.write("\n");
          process.exit(130);
        }
        if (ch === "\u007f" || ch === "\b") {
          if (value) {
            value = value.slice(0, -1);
            stdout.write("\b \b");
          }
          continue;
        }
        if (ch < " ") continue;
        value += ch;
        stdout.write(hidden ? "*" : ch);
      }
    }
    stdin.on("data", onData);
  });
}

function putCloudflareSecret(name, value) {
  const wrangler = join(ROOT, "node_modules", "wrangler", "bin", "wrangler.js");
  if (!existsSync(wrangler)) fail("wrangler is not installed — run `npm install` first.");
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [wrangler, "secret", "put", name], { cwd: ROOT, stdio: ["pipe", "inherit", "inherit"] });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`wrangler exited with code ${code}`))));
    child.stdin.end(value);
  });
}

function putDevVar(name, value) {
  const file = join(ROOT, ".dev.vars");
  const quoted = value.includes("'") ? `"${value}"` : `'${value}'`;
  const lines = existsSync(file) ? readFileSync(file, "utf8").split(/\r?\n/).filter((l) => l && !l.startsWith(`${name}=`)) : [];
  lines.push(`${name}=${quoted}`);
  writeFileSync(file, lines.join("\n") + "\n");
}

async function store(name, value) {
  if (local) {
    putDevVar(name, value);
    ok(`${name} written to .dev.vars (git-ignored).`);
  } else {
    await putCloudflareSecret(name, value);
  }
}

async function mongodb() {
  const user = option("user", DEFAULT_USER);
  const host = option("host", DEFAULT_HOST);
  console.log(`MongoDB user: ${user}\nAtlas host:   ${host}\n`);
  const password = await ask(`Password for ${user} (hidden): `, { hidden: true });
  if (!password) fail("No password entered.");
  if (/[<>]/.test(password) || /db_password/i.test(password)) {
    fail("That looks like the <db_password> placeholder, or a whole connection string. Enter only the password itself.");
  }
  if (password.startsWith("mongodb")) fail("Enter only the password, not the whole connection string.");

  const uri = `mongodb+srv://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${host}/?retryWrites=true&w=majority&appName=apps-script-cache`;
  await testMongo(uri, { user, host, password, allowAdmin: flag("allow-admin") });
  await store("MONGODB_URI", uri);
}

/** Logs in to Atlas with `uri`, prints the user + roles, and checks write access to cache_proxy. Exits on failure. */
async function testMongo(uri, { user, host, password, allowAdmin }) {
  console.log("Testing the login against Atlas from this computer…");
  // Some PCs route DNS through a local proxy (127.0.0.1) that refuses SRV lookups; this test only needs public DNS.
  try {
    await dns.promises.resolveSrv(`_mongodb._tcp.${host}`);
  } catch {
    dns.setServers(["1.1.1.1", "8.8.8.8"]);
    dns.promises.setServers(["1.1.1.1", "8.8.8.8"]);
  }
  const { MongoClient } = await import("mongodb");
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 15_000, appName: "apps-script-cache-setup" });
  try {
    await client.connect();
    const status = await client.db("admin").command({ connectionStatus: 1 });
    const roles = status.authInfo?.authenticatedUserRoles ?? [];
    const who = (status.authInfo?.authenticatedUsers ?? []).map((u) => `${u.user}@${u.db}`).join(", ");
    ok(`Logged in as ${who}`);
    console.log(`  Roles: ${roles.map((r) => `${r.role}@${r.db}`).join(", ") || "(none)"}`);
    const broad = roles.filter((r) => BROAD_ROLES.has(r.role));
    if (broad.length && allowAdmin) {
      console.log(`\x1b[33m!\x1b[0m ${user} has broad roles (${broad.map((r) => r.role).join(", ")}). Works, but a readWrite-only user is safer (see README).`);
    } else if (broad.length) {
      fail(`This user has broad roles (${broad.map((r) => r.role).join(", ")}). Create ${DEFAULT_USER} with readWrite on ${DB_NAME} only.`);
    }
    const probe = client.db(DB_NAME).collection("setup_check");
    const { insertedId } = await probe.insertOne({ at: new Date() });
    await probe.deleteOne({ _id: insertedId });
    ok(`Write access to the ${DB_NAME} database confirmed.`);
  } catch (err) {
    const msg = String(err?.message ?? err);
    if (/bad auth|authentication failed/i.test(msg)) {
      fail(`Atlas rejected ${user} / password. Check Atlas → Security → Database & Network Access → Database Users in project apps-script-cache: the user must exist there and the password must match.`);
    }
    if (/not authorized/i.test(msg)) fail(`Login worked but ${user} cannot write to ${DB_NAME}. Give it the readWrite role on ${DB_NAME}.`);
    if (/querySrv|ENOTFOUND|ENODATA/i.test(msg)) fail(`Could not resolve ${host}. Check the cluster host name.`);
    fail(`Connection failed: ${msg.split(encodeURIComponent(password)).join("***").split(password).join("***")}`);
  } finally {
    await client.close().catch(() => {});
  }
}

/** Minimal .env parser: KEY=value, KEY="value" or KEY='value'; # comments. */
function parseEnvFile(file) {
  const out = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trimStart().startsWith("#")) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

/** Reads .env, validates every value, tests the MongoDB login, then uploads all secrets to Cloudflare. */
async function envFile() {
  const file = join(ROOT, ".env");
  if (!existsSync(file)) fail("No .env file. Copy .env.example to .env and fill it in.");
  const env = parseEnvFile(file);
  const uri = (env.MONGODB_URI ?? "").trim();
  const adminKey = (env.ADMIN_KEY ?? "").trim();
  const sessionSecret = (env.SESSION_SECRET ?? "").trim();

  const m = /^mongodb(?:\+srv)?:\/\/([^:@/]+):([^@/]+)@([^/?]+)/.exec(uri);
  if (!m) fail("MONGODB_URI in .env must look like mongodb+srv://USER:PASSWORD@cache-cluster.iplzsxd.mongodb.net/...");
  const [, rawUser, rawPassword, host] = m;
  if (/[<>]|db_password|PASSWORD|YOUR_/i.test(rawPassword)) fail("MONGODB_URI still contains a placeholder — replace it with the real password.");
  if (adminKey.length < 12 || /change-me|at-least/i.test(adminKey)) fail("ADMIN_KEY in .env must be your own password, at least 12 characters.");

  await testMongo(uri, { user: decodeURIComponent(rawUser), host, password: decodeURIComponent(rawPassword), allowAdmin: true });

  if (local) {
    console.log("wrangler dev reads .env directly (when there is no .dev.vars), nothing to upload.");
    return;
  }
  console.log("Uploading secrets to Cloudflare…");
  await putCloudflareSecret("MONGODB_URI", uri);
  await putCloudflareSecret("ADMIN_KEY", adminKey);
  // Empty SESSION_SECRET in .env = keep the one already on Cloudflare (set during setup).
  if (sessionSecret) await putCloudflareSecret("SESSION_SECRET", sessionSecret);
  if (GOOGLE_KEYS.every((k) => env[k]?.trim())) {
    for (const k of GOOGLE_KEYS) await putCloudflareSecret(k, env[k].trim());
  }
  ok("All secrets uploaded. Sign in at https://apps-script-cache.manishx112.workers.dev with your ADMIN_KEY.");
}

const GOOGLE_KEYS = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_REFRESH_TOKEN", "GOOGLE_DRIVE_FOLDER_ID"];

/** Sets or replaces KEY='value' lines in .env without touching the others. */
function setEnvValues(values) {
  const file = join(ROOT, ".env");
  let lines = existsSync(file) ? readFileSync(file, "utf8").split(/\r?\n/) : [];
  for (const [k, v] of Object.entries(values)) {
    const line = `${k}='${v}'`;
    const i = lines.findIndex((l) => new RegExp(`^\\s*${k}\\s*=`).test(l));
    if (i >= 0) lines[i] = line;
    else lines.push(line);
  }
  writeFileSync(file, lines.join("\n").replace(/\n*$/, "\n"));
}

function openBrowser(url) {
  // rundll32 avoids cmd.exe treating the "&" in the URL as a command separator.
  const [cmd, args] = process.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]] : [process.platform === "darwin" ? "open" : "xdg-open", [url]];
  spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref();
}

/**
 * One-time Google Drive connection: opens Google's consent page, receives the code on a local port,
 * exchanges it for a refresh token, creates the "Apps Script Cache" folder, saves everything to .env
 * and uploads it to Cloudflare. Needs GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env (see DRIVE.md).
 */
async function google() {
  const file = join(ROOT, ".env");
  const env = existsSync(file) ? parseEnvFile(file) : {};
  const clientId = (env.GOOGLE_CLIENT_ID ?? "").trim();
  const clientSecret = (env.GOOGLE_CLIENT_SECRET ?? "").trim();
  if (!clientId.endsWith(".apps.googleusercontent.com") || !clientSecret) {
    fail("Put GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env first (steps in DRIVE.md).");
  }

  const { createServer } = await import("node:http");
  const state = randomBytes(16).toString("hex");
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const redirectUri = `http://127.0.0.1:${server.address().port}`;
  const authUrl =
    "https://accounts.google.com/o/oauth2/v2/auth?" +
    new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "https://www.googleapis.com/auth/drive.file",
      access_type: "offline",
      prompt: "consent",
      state,
    });

  console.log("Opening Google in your browser — choose your account and click Allow.");
  console.log(`If nothing opens, paste this link into the browser:\n${authUrl}\n`);
  openBrowser(authUrl);

  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out after 5 minutes waiting for Google.")), 5 * 60_000);
    server.on("request", (req, res) => {
      const u = new URL(req.url ?? "/", redirectUri);
      if (u.pathname !== "/") return res.writeHead(404).end();
      const good = u.searchParams.get("code") && u.searchParams.get("state") === state;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(
        good
          ? "<h2 style='font-family:sans-serif'>✅ Google Drive connected. You can close this tab and go back to the terminal.</h2>"
          : `<h2 style='font-family:sans-serif'>❌ ${u.searchParams.get("error") ?? "Something went wrong"} — go back to the terminal.</h2>`,
      );
      clearTimeout(timer);
      server.close();
      if (good) resolve(u.searchParams.get("code"));
      else reject(new Error(`Google said: ${u.searchParams.get("error") ?? "invalid response"}`));
    });
  }).catch((err) => fail(err.message));

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ code, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: "authorization_code" }),
  });
  const tokens = await tokenRes.json();
  if (!tokenRes.ok) fail(`Google token exchange failed: ${tokens.error_description ?? tokens.error ?? tokenRes.status}`);
  if (!tokens.refresh_token) {
    fail("Google did not return a refresh token. Remove the app at https://myaccount.google.com/permissions and run this again.");
  }
  ok("Google account connected.");

  // Reuse the folder from an earlier run if it still exists, otherwise create it.
  const auth = { authorization: `Bearer ${tokens.access_token}` };
  let folderId = (env.GOOGLE_DRIVE_FOLDER_ID ?? "").trim();
  if (folderId) {
    const check = await fetch(`https://www.googleapis.com/drive/v3/files/${folderId}?fields=id,trashed`, { headers: auth });
    const info = check.ok ? await check.json() : null;
    if (!info || info.trashed) folderId = "";
  }
  if (!folderId) {
    const res = await fetch("https://www.googleapis.com/drive/v3/files?fields=id", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ name: "Apps Script Cache", mimeType: "application/vnd.google-apps.folder" }),
    });
    const folder = await res.json();
    if (!res.ok) fail(`Could not create the Drive folder: ${folder.error?.message ?? res.status}`);
    folderId = folder.id;
  }
  ok(`Drive folder ready: https://drive.google.com/drive/folders/${folderId}`);

  setEnvValues({ GOOGLE_REFRESH_TOKEN: tokens.refresh_token, GOOGLE_DRIVE_FOLDER_ID: folderId });
  ok("Saved to .env");
  if (local) return;

  console.log("Uploading Google secrets to Cloudflare…");
  const values = { GOOGLE_CLIENT_ID: clientId, GOOGLE_CLIENT_SECRET: clientSecret, GOOGLE_REFRESH_TOKEN: tokens.refresh_token, GOOGLE_DRIVE_FOLDER_ID: folderId };
  for (const k of GOOGLE_KEYS) await putCloudflareSecret(k, values[k]);
  ok("Done! From the next refresh, every source's JSON is saved in the Drive folder above.");
}

async function adminKey() {
  const key = await ask("New dashboard password (ADMIN_KEY, hidden): ", { hidden: true });
  if (key.length < 12) fail("Use at least 12 characters.");
  const again = await ask("Repeat it: ", { hidden: true });
  if (key !== again) fail("The two entries do not match.");
  await store("ADMIN_KEY", key);
}

async function session() {
  await store("SESSION_SECRET", randomBytes(32).toString("base64url"));
}

const commands = { mongodb, "admin-key": adminKey, session, env: envFile, google };
if (!commands[command]) {
  console.log("Usage: node scripts/set-secret.mjs <env|google|mongodb|admin-key|session> [--local] [--user name] [--host host]");
  process.exit(command ? 1 : 0);
}
await commands[command]();
