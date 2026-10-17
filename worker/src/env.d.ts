// Secrets are not in wrangler.toml, so `wrangler types` cannot see them. Set with `npm run secrets`.
interface Env {
  ADMIN_KEY: string;
  SESSION_SECRET: string;
  // Optional Google Drive storage (set by `npm run google:connect`). When all four are set,
  // snapshots are stored as files in Drive and D1 keeps only the file id.
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  GOOGLE_REFRESH_TOKEN?: string;
  GOOGLE_DRIVE_FOLDER_ID?: string;
}
