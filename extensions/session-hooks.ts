import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { consumePendingChildOrigin, createSessionHookController } from "./session-search/hooks.js";
import { loadSettings } from "./shared/settings.js";

export default function sessionHooksExtension(pi: ExtensionAPI): void {
  const settings = loadSettings();
  const controller = createSessionHookController({ indexPath: settings.index.path });

  pi.on("session_start", async (_event, ctx) => {
    await controller.handleSessionStart(ctx.sessionManager.getSessionFile(), ctx.cwd);
  });

  pi.on("session_switch", async (event, ctx) => {
    const sessionFile = ctx.sessionManager.getSessionFile();
    const sessionOrigin =
      event.reason === "new" && event.previousSessionFile
        ? consumePendingChildOrigin(event.previousSessionFile)
        : undefined;

    await controller.handleSessionSwitch(
      event.previousSessionFile,
      sessionFile,
      ctx.cwd,
      sessionOrigin,
    );
  });

  pi.on("session_fork", async (event, ctx) => {
    await controller.handleSessionFork(
      event.previousSessionFile,
      ctx.sessionManager.getSessionFile(),
      ctx.cwd,
    );
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
