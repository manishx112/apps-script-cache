import { type ReactNode, useState } from "react";
import { toast } from "sonner";
import { api, ApiError, type Source } from "../api";
import { formatBytes, formatMs } from "../lib/format";
import { useConfirm } from "./ui";

export type ActionName = "refresh" | "toggle" | "delete" | "rotate";

/**
 * Refresh / pause-resume / delete / rotate with confirmations and toasts.
 * `onChange(updated | null)` receives the new source (null after delete).
 */
export function useSourceActions(onChange: (id: string, updated: Source | null) => void) {
  const [confirm, dialog] = useConfirm();
  const [busy, setBusy] = useState<Record<string, ActionName | undefined>>({});

  async function run(s: Source, name: ActionName, fn: () => Promise<void>) {
    setBusy((b) => ({ ...b, [s.id]: name }));
    try {
      await fn();
    } catch (err) {
      toast.error(err instanceof ApiError ? err.message : "Something went wrong.");
    } finally {
      setBusy((b) => ({ ...b, [s.id]: undefined }));
    }
  }

  const actions = {
    refresh: (s: Source) =>
      run(s, "refresh", async () => {
        const t = toast.loading(`Fetching “${s.name}” from Apps Script…`);
        try {
          const { result, source } = await api.refresh(s.id);
          onChange(s.id, source);
          if (result.ok) toast.success(`Refreshed in ${formatMs(result.durationMs)} · ${formatBytes(result.sizeBytes)}`, { id: t });
          else toast.error(`Fetch failed: ${result.error}`, { id: t, description: "The last good data is still being served." });
        } catch (err) {
          toast.dismiss(t);
          throw err;
        }
      }),
    toggle: (s: Source) =>
      run(s, "toggle", async () => {
        const status = s.status === "active" ? "paused" : "active";
        const { source } = await api.updateSource(s.id, { status });
        onChange(s.id, source);
        toast.success(status === "paused" ? `Paused “${s.name}” — the link keeps serving the last data.` : `Resumed “${s.name}”.`);
      }),
    delete: async (s: Source) => {
      const ok = await confirm({
        title: `Delete “${s.name}”?`,
        body: "Its link will stop working immediately and the cached data and logs are removed. This cannot be undone.",
        confirmLabel: "Delete source",
        danger: true,
      });
      if (!ok) return;
      await run(s, "delete", async () => {
        await api.deleteSource(s.id);
        onChange(s.id, null);
        toast.success(`Deleted “${s.name}”.`);
      });
    },
    rotate: async (s: Source) => {
      const ok = await confirm({
        title: "Create a new link?",
        body: (
          <>
            The current link for <b>{s.name}</b> will <b>stop working</b> (cached copies expire within about a minute). Dashboards using it must be
            updated with the new link.
          </>
        ),
        confirmLabel: "Rotate link",
        danger: true,
      });
      if (!ok) return;
      await run(s, "rotate", async () => {
        const { source } = await api.rotateToken(s.id);
        onChange(s.id, source);
        toast.success("New link created — the old one no longer works.");
      });
    },
  };

  return { actions, busy, dialog: dialog as ReactNode };
}
