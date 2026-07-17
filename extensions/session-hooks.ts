import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  findPendingHandoffBootstrap,
  getHandoffMetadataFromEntries,
} from "./session-handoff/metadata.ts";
import { createSessionHookController } from "./session-search/hooks.ts";
import { loadSettings } from "./shared/settings.ts";

interface SessionStartLifecycleEvent {
  reason?: "startup" | "reload" | "new" | "resume" | "fork";
  previousSessionFile?: string;
}

export default function sessionHooksExtension(pi: ExtensionAPI): void {
  const settings = loadSettings();
  const controller = createSessionHookController({ indexPath: settings.index.path });

  pi.on("session_start", async (event, ctx) => {
    const { reason, previousSessionFile } = event as SessionStartLifecycleEvent;
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
  });

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

  pi.on("session_shutdown", async (_event, ctx) => {
    await controller.handleSessionShutdown(ctx.sessionManager.getSessionFile(), ctx.cwd);
  });
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
