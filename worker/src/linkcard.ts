// "Link cards": a small KV entry per public link (Drive-mode sources) holding everything a
// public read needs — the Drive file id plus the fields shown by /meta. On a cache miss the
// Worker reads the card and then Drive, without opening a MongoDB connection.
//
// KV free tier: 1,000 writes/day, so cards are written only when something visible changes
// (new data, an error, an edit) or at most every CARD_MAX_AGE_MS to keep "fetched at" fresh.

import type { SourceDoc } from "./db";
import { driveEnabled } from "./drive";

export interface LinkCard {
  sourceId: string;
  name: string;
  status: SourceDoc["status"];
  intervalMin: number;
  driveFileId: string;
  lastFetchedAt: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  lastDurationMs: number | null;
  lastSizeBytes: number | null;
}

export const CARD_MAX_AGE_MS = 30 * 60_000;
const key = (token: string) => `link:${token}`;
const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);

type CardSource = Pick<SourceDoc, "_id" | "token" | "name" | "status" | "intervalMin" | "driveFileId" | "lastFetchedAt" | "lastSuccessAt" | "lastError" | "lastDurationMs" | "lastSizeBytes">;

/** Writes (or replaces) the card. No-op unless Drive mode is on and the source has a Drive file. */
export async function putCard(env: Env, s: CardSource): Promise<boolean> {
  if (!driveEnabled(env) || !s.driveFileId) return false;
  const card: LinkCard = {
    sourceId: s._id.toHexString(),
    name: s.name,
    status: s.status,
    intervalMin: s.intervalMin,
    driveFileId: s.driveFileId,
    lastFetchedAt: iso(s.lastFetchedAt),
    lastSuccessAt: iso(s.lastSuccessAt),
    lastError: s.lastError,
    lastDurationMs: s.lastDurationMs,
    lastSizeBytes: s.lastSizeBytes,
  };
  try {
    await env.SCHEDULER.put(key(s.token), JSON.stringify(card));
    return true;
  } catch (err) {
    console.error("link card write failed", String(err));
    return false;
  }
}

export async function getCard(env: Env, token: string): Promise<LinkCard | null> {
  if (!driveEnabled(env)) return null;
  return (await env.SCHEDULER.get<LinkCard>(key(token), "json").catch(() => null)) ?? null;
}

export async function deleteCard(env: Env, token: string): Promise<void> {
  await env.SCHEDULER.delete(key(token)).catch(() => {});
}
