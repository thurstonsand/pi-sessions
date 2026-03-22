import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createSessionHookController } from "./session-search/hooks.js";

export default function sessionHooksExtension(pi: ExtensionAPI): void {
  const controller = createSessionHookController();

  pi.on("session_start", async (_event, ctx) => {
    await controller.handleSessionStart(ctx.sessionManager.getSessionFile(), ctx.cwd);
  });

  pi.on("session_switch", async (event, ctx) => {
    await controller.handleSessionSwitch(
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
