// `wrangler dev` refuses to start if the static-assets folder is missing (it is created by `npm run build:web`).
import { existsSync, mkdirSync, writeFileSync } from "node:fs";

const dir = new URL("../worker/public/", import.meta.url);
if (!existsSync(dir)) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(new URL("index.html", dir), "<!doctype html><p>Run the Vite dev server (http://localhost:5173) or <code>npm run build:web</code>.</p>\n");
}
