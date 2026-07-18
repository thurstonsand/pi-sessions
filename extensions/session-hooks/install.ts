import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  findPendingHandoffBootstrap,
  getHandoffMetadataFromEntries,
} from "../session-handoff/metadata.ts";
import { createSessionHookController } from "../session-search/hooks.ts";
import type { IndexHandle, SessionLifecycle } from "../shared/composition.ts";
import type { SessionSettings } from "../shared/settings.ts";

export function installHooks(
  pi: ExtensionAPI,
  deps: { settings: SessionSettings; index: IndexHandle },
): SessionLifecycle {
  const controller = createSessionHookController({ indexPath: deps.index.path });

  pi.on("tool_call", async (event, ctx) => {
    controller.handleToolCall(event, ctx.sessionManager.getSessionFile(), ctx.cwd);
  });

  pi.on("tool_result", async (event) => {
    controller.handleToolResult(event);
  });

  pi.on("turn_end", async (_event, ctx) => {
    await controller.handleTurnEnd(ctx.sessionManager.getSessionFile(), ctx.cwd);
  });

  pi.on("session_tree", async (_event, ctx) => {
    await controller.handleSessionTree(ctx.sessionManager.getSessionFile(), ctx.cwd);
  });

  pi.on("session_compact", async (_event, ctx) => {
    await controller.handleSessionCompact(ctx.sessionManager.getSessionFile(), ctx.cwd);
  });

  return {
    async onSessionStart(event, ctx) {
      const { reason, previousSessionFile } = event;
      const sessionFile = ctx.sessionManager.getSessionFile();

      switch (reason) {
        case "new":
        case "resume":
          await controller.handleSessionSwitch(
            previousSessionFile,
            sessionFile,
            ctx.cwd,
            getSessionStartOrigin(ctx),
          );
          break;
        case "fork":
          await controller.handleSessionFork(previousSessionFile, sessionFile, ctx.cwd);
          break;
        default:
          await controller.handleSessionStart(sessionFile, ctx.cwd);
          break;
      }
    },
    async onSessionShutdown(_event, ctx) {
      await controller.handleSessionShutdown(ctx.sessionManager.getSessionFile(), ctx.cwd);
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
