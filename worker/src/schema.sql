-- D1 (SQLite) schema. The Worker runs this on first use in each instance (every statement is
-- idempotent), and scripts/migrate-from-mongodb.mjs runs it before copying data.
-- Dates are stored as milliseconds since 1970 (INTEGER).

CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  scriptUrl TEXT NOT NULL,
  intervalMin INTEGER NOT NULL,
  token TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  lastFetchedAt INTEGER,
  lastSuccessAt INTEGER,
  lastError TEXT,
  lastDurationMs INTEGER,
  lastSizeBytes INTEGER,
  createdAt INTEGER NOT NULL,
  driveFileId TEXT,
  driveFolderId TEXT,
  driveContentHash TEXT,
  linkCardAt INTEGER,
  schedule TEXT
);

-- Latest response per source, only when Google Drive storage is off (text split over chunks).
CREATE TABLE IF NOT EXISTS snapshots (
  sourceId TEXT PRIMARY KEY,
  fetchedAt INTEGER NOT NULL,
  sizeBytes INTEGER NOT NULL,
  chunkVersion TEXT NOT NULL,
  chunkCount INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS snapshot_chunks (
  sourceId TEXT NOT NULL,
  version TEXT NOT NULL,
  n INTEGER NOT NULL,
  text TEXT NOT NULL,
  PRIMARY KEY (sourceId, version, n)
);

-- Kept for 7 days (the cron deletes older rows).
CREATE TABLE IF NOT EXISTS fetch_logs (
  sourceId TEXT NOT NULL,
  at INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  durationMs INTEGER NOT NULL,
  sizeBytes INTEGER,
  error TEXT
);

CREATE INDEX IF NOT EXISTS fetch_logs_source_at ON fetch_logs (sourceId, at DESC);
CREATE INDEX IF NOT EXISTS fetch_logs_at ON fetch_logs (at);
