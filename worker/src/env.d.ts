// Secrets are not in wrangler.toml, so `wrangler types` cannot see them. Set with `npm run secret:*`.
interface Env {
  MONGODB_URI: string;
  ADMIN_KEY: string;
  SESSION_SECRET: string;
}
