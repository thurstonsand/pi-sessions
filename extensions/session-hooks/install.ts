import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  findPendingHandoffBootstrap,
  getHandoffMetadataFromEntries,
} from "../session-handoff/metadata.ts";
import type { IndexHandle, SessionLifecycle } from "../shared/composition.ts";
import { requestIndexRecovery } from "../shared/session-index/recovery.ts";
import { createSessionHookController } from "../shared/session-index/sync.ts";

export function installHooks(
  pi: ExtensionAPI,
  deps: { index: IndexHandle; turnSync: boolean; getSessionEpoch: () => number },
): SessionLifecycle {
  const controller = createSessionHookController({ indexPath: deps.index.path });

  pi.on("turn_end", async (_event, ctx) => {
    if (deps.turnSync) await controller.handleTurnEnd(ctx.sessionManager.getSessionFile());
  });

  pi.on("session_tree", async (_event, ctx) => {
    if (deps.turnSync) await controller.handleSessionTree(ctx.sessionManager.getSessionFile());
  });

  pi.on("session_compact", async (_event, ctx) => {
    if (deps.turnSync) await controller.handleSessionCompact(ctx.sessionManager.getSessionFile());
  });

  return {
    async onSessionStart(event, ctx) {
      const { reason, previousSessionFile } = event;
      const epoch = deps.getSessionEpoch();
      const sessionFile = ctx.sessionManager.getSessionFile();
      // Recovery can outlive this session; once its epoch ends, ctx is stale and the
      // controller belongs to whichever session came next.
      void requestIndexRecovery(deps.index.path, true)
        .then(() => {
          if (deps.getSessionEpoch() === epoch) return controller.handleSessionStart(sessionFile);
        })
        .catch((error: unknown) => {
          const message = `Session index sync failed: ${String(error)}`;
          if (deps.getSessionEpoch() === epoch) ctx.ui.notify(message, "error");
          else console.error(message);
        });

      switch (reason) {
        case "new":
        case "resume":
          await controller.handleSessionSwitch(
            previousSessionFile,
            sessionFile,
            getSessionStartOrigin(ctx),
          );
          break;
        case "fork":
          await controller.handleSessionFork(previousSessionFile, sessionFile);
          break;
        default:
          await controller.handleSessionStart(sessionFile);
          break;
      }
    },
    async onSessionShutdown(_event, ctx) {
      await controller.handleSessionShutdown(ctx.sessionManager.getSessionFile());
    },
  };
}

function getSessionStartOrigin(ctx: ExtensionContext): "handoff" | undefined {
  const entries = ctx.sessionManager.getEntries();
  if (getHandoffMetadataFromEntries(entries)) {
    return "handoff";
  }

  const scan = findPendingHandoffBootstrap(ctx.sessionManager.getBranch());
  return scan?.kind === "pending" && scan.bootstrap.sessionId === ctx.sessionManager.getSessionId()
    ? "handoff"
    : undefined;
}
