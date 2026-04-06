import { describe, expect, it, vi } from "vitest";
import { createSessionAutoTitleCommandHandler } from "../extensions/session-auto-title.js";

describe("session auto-title command", () => {
  it("rejects unexpected arguments", async () => {
    const ctx = createCommandContext();
    const handler = createSessionAutoTitleCommandHandler(vi.fn(async () => true));

    await handler("now", ctx as never);

    expect(ctx.waitForIdle).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith("Usage: /retitle", "error");
  });

  it("waits for idle and surfaces successful retitles through the runner", async () => {
    const ctx = createCommandContext();
    const runRetitle = vi.fn(async () => true);
    const handler = createSessionAutoTitleCommandHandler(runRetitle);

    await handler("", ctx as never);

    expect(ctx.waitForIdle).toHaveBeenCalledTimes(1);
    expect(runRetitle).toHaveBeenCalledWith(ctx);
    expect(ctx.ui.notify).not.toHaveBeenCalledWith("Session retitle failed.", "error");
  });

  it("reports manual retitle failures", async () => {
    const ctx = createCommandContext();
    const handler = createSessionAutoTitleCommandHandler(vi.fn(async () => false));

    await handler("", ctx as never);

    expect(ctx.ui.notify).toHaveBeenCalledWith("Session retitle failed.", "error");
  });
});

function createCommandContext() {
  return {
    waitForIdle: vi.fn(async () => {}),
    ui: {
      notify: vi.fn(),
    },
  };
}
