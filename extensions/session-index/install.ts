import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { IndexHandle, SessionLifecycle } from "../shared/composition.ts";
import { isTuiMode } from "../shared/pi-mode.ts";
import { getIndexStatus, type SessionIndexStatus } from "../shared/session-index/index.ts";
import {
  getIndexRecoveryMessage,
  observeIndexRecovery,
  type ReindexResult,
  rebuildSessionIndex,
} from "../shared/session-index/recovery.ts";
import type { SessionSettings } from "../shared/settings.ts";

import { ReindexLoader } from "./loader.ts";
import { describeSessionIndexStatus, type SessionIndexAction, SessionIndexPanel } from "./panel.ts";

export function installIndex(
  pi: ExtensionAPI,
  deps: { settings: SessionSettings },
): IndexHandle & SessionLifecycle {
  const indexPath = deps.settings.index.path;
  let lastNotice: string | undefined;
  let stopObserving: (() => void) | undefined;

  pi.registerCommand("session-index", {
    description: "Open the session index control panel",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/session-index requires interactive mode.", "warning");
        return;
      }

      const status = getIndexStatus(indexPath);
      status.recoveryMessage = getIndexRecoveryMessage(indexPath);
      const action = isTuiMode(ctx)
        ? await ctx.ui.custom<SessionIndexAction>(
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
          )
        : await selectSessionIndexAction(ctx, status);

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

      if (!isTuiMode(ctx)) {
        ctx.ui.notify("Rebuilding session index...", "info");
        try {
          notifyReindexed(ctx, await rebuildSessionIndex({ indexPath }));
        } catch (error) {
          ctx.ui.notify(`Reindex failed: ${String(error)}`, "error");
        }
        return;
      }

      const result = await runReindexWithLoader(ctx, indexPath);
      if (!result) {
        ctx.ui.notify("Reindex cancelled.", "info");
        return;
      }

      notifyReindexed(ctx, result);
    },
  });

  return {
    path: indexPath,
    onSessionStart(_event, ctx) {
      stopObserving = observeIndexRecovery(indexPath, (message) => {
        ctx.ui.setStatus("session-index", message);
        if (message && message !== lastNotice && !message.includes("in progress")) {
          ctx.ui.notify(message, "error");
        }
        lastNotice = message;
      });
    },
    onSessionShutdown() {
      stopObserving?.();
      stopObserving = undefined;
    },
  };
}

const REBUILD_INDEX_OPTION = "Rebuild from disk";

async function selectSessionIndexAction(
  ctx: ExtensionCommandContext,
  status: SessionIndexStatus,
): Promise<SessionIndexAction> {
  const lines = describeSessionIndexStatus(status).map((line) => `- ${line}`);
  if (status.recoveryMessage) lines.push("", status.recoveryMessage);
  const choice = await ctx.ui.select(["**Session Index**", "", ...lines].join("\n"), [
    REBUILD_INDEX_OPTION,
    "Close",
  ]);
  return choice === REBUILD_INDEX_OPTION ? "reindex" : undefined;
}

function notifyReindexed(ctx: ExtensionCommandContext, result: ReindexResult): void {
  ctx.ui.notify(
    `Indexed ${result.sessionCount} sessions and ${result.chunkCount} text chunks.`,
    "info",
  );
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
