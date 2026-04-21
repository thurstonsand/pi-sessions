import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { HANDOFF_BOOTSTRAP_ENV, parseHandoffBootstrap } from "./session-handoff/metadata.js";
import { createSessionHookController } from "./session-search/hooks.js";
import { loadSettings } from "./shared/settings.js";

interface SessionStartLifecycleEvent {
  reason?: "startup" | "reload" | "new" | "resume" | "fork";
}

export default function sessionHooksExtension(pi: ExtensionAPI): void {
  const settings = loadSettings();
  const controller = createSessionHookController({ indexPath: settings.index.path });

  pi.on("session_start", async (event, ctx) => {
    const { reason } = event as SessionStartLifecycleEvent;
    const sessionFile = ctx.sessionManager.getSessionFile();

    switch (reason) {
      case "new":
      case "resume":
        await controller.handleSessionSwitch(sessionFile, ctx.cwd, getSessionStartOrigin(ctx));
        break;
      case "fork":
        await controller.handleSessionFork(sessionFile, ctx.cwd);
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
  const encodedBootstrap = process.env[HANDOFF_BOOTSTRAP_ENV];
  if (!encodedBootstrap) {
    return undefined;
  }

  const bootstrap = parseHandoffBootstrap(encodedBootstrap);
  if (!bootstrap) {
    return undefined;
  }

  return bootstrap.sessionId === ctx.sessionManager.getSessionId() ? "handoff" : undefined;
}
