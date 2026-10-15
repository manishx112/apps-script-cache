import { handleApi } from "./admin";
import { errorJson, HttpError, redact } from "./http";
import { handlePublic } from "./public";
import { runScheduler } from "./scheduler";

export default {
  async fetch(req, env, ctx): Promise<Response> {
    const { pathname } = new URL(req.url);
    try {
      if (pathname.startsWith("/d/")) return await handlePublic(req, env, ctx);
      if (pathname.startsWith("/api/")) {
        const res = await handleApi(req, env, ctx);
        res.headers.set("cache-control", "no-store");
        return res;
      }
      // Static files and SPA fallback (normally served before the Worker runs; see wrangler.toml).
      return env.ASSETS.fetch(req);
    } catch (err) {
      if (err instanceof HttpError) return errorJson(err.status, err.message);
      const message = redact(String((err as Error)?.message ?? err), env);
      console.error(`${req.method} ${pathname} failed:`, redact(String((err as Error)?.stack ?? err), env));
      return errorJson(500, `Server error: ${message}`);
    }
  },

  async scheduled(controller, env, ctx): Promise<void> {
    ctx.waitUntil(
      runScheduler(env, controller.scheduledTime).catch((err) => {
        console.error("scheduler failed:", redact(String((err as Error)?.stack ?? err), env));
      }),
    );
  },
} satisfies ExportedHandler<Env>;
