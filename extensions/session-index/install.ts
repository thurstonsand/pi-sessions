import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { type ReindexResult, rebuildSessionIndex } from "../session-search/reindex.ts";
import type { IndexHandle } from "../shared/composition.ts";
import { isTuiMode } from "../shared/pi-mode.ts";
import { getIndexStatus } from "../shared/session-index/index.ts";
import type { SessionSettings } from "../shared/settings.ts";

import { ReindexLoader } from "./loader.ts";
import { type SessionIndexAction, SessionIndexPanel } from "./panel.ts";

export function installIndex(pi: ExtensionAPI, deps: { settings: SessionSettings }): IndexHandle {
  const indexPath = deps.settings.index.path;

  pi.registerCommand("session-index", {
    description: "Open the session index control panel",
    handler: async (_args, ctx) => {
      if (!isTuiMode(ctx)) {
        ctx.ui.notify("/session-index requires interactive mode.", "warning");
        return;
      }

      const status = getIndexStatus(indexPath);
      const action = await ctx.ui.custom<SessionIndexAction>(
        (tui, theme, _keybindings, done) =>
          new SessionIndexPanel(theme, status, done, () => tui.requestRender()),
        {
          overlay: true,
          overlayOptions: {
            anchor: "center",
            width: 72,
            margin: 1,
          },
        },
      );

      if (action !== "reindex") {
        return;
      }

      const confirmed = await ctx.ui.confirm(
        "Rebuild session index?",
        "This rebuilds the entire session index from disk. Continue?",
      );
      if (!confirmed) {
        ctx.ui.notify("Reindex cancelled.", "info");
        return;
      }

      const result = await runReindexWithLoader(ctx, indexPath);
      if (!result) {
        ctx.ui.notify("Reindex cancelled.", "info");
        return;
      }

      ctx.ui.notify(
        `Indexed ${result.sessionCount} sessions and ${result.chunkCount} text chunks.`,
        "info",
      );
    },
  });

  return { path: indexPath };
}

async function runReindexWithLoader(
  ctx: ExtensionCommandContext,
  indexPath: string,
): Promise<ReindexResult | null> {
  return ctx.ui.custom<ReindexResult | null>((tui, theme, keybindings, done) => {
    const loader = new ReindexLoader(tui, theme, keybindings, () => done(null));

    void (async () => {
      try {
        const result = await rebuildSessionIndex({ indexPath });
        done(result);
      } catch (error) {
        ctx.ui.notify(`Reindex failed: ${String(error)}`, "error");
        done(null);
      }
    })();

    return loader;
  });
}
