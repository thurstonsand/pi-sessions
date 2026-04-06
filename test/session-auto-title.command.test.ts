import { describe, expect, it, vi } from "vitest";
import {
  createSessionAutoTitleCommandHandler,
  getRetitleArgumentCompletions,
  parseRetitleCommand,
} from "../extensions/session-auto-title.js";

describe("session auto-title command", () => {
  it("rejects unexpected arguments", async () => {
    const ctx = createCommandContext({ hasUI: false });
    const handler = createSessionAutoTitleCommandHandler(vi.fn(async () => "success" as const));

    await handler("now", ctx as never);

    expect(ctx.waitForIdle).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith("Usage: /title [this|folder|pi] [-f]", "error");
  });

  it("opens the pane by default in interactive mode", async () => {
    const ctx = createCommandContext({ hasUI: true });
    const execute = vi.fn(async () => "cancelled" as const);
    const handler = createSessionAutoTitleCommandHandler(execute);

    await handler("", ctx as never);

    expect(ctx.waitForIdle).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledWith({ kind: "open-pane" }, ctx);
  });

  it("waits for idle before direct retitles in non-interactive mode", async () => {
    const ctx = createCommandContext({ hasUI: false });
    const execute = vi.fn(async () => "success" as const);
    const handler = createSessionAutoTitleCommandHandler(execute);

    await handler("", ctx as never);

    expect(ctx.waitForIdle).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledWith({ kind: "run", scope: "this" }, ctx);
    expect(ctx.ui.notify).not.toHaveBeenCalledWith("Session retitle failed.", "error");
  });

  it("reports retitle failures", async () => {
    const ctx = createCommandContext({ hasUI: false });
    const handler = createSessionAutoTitleCommandHandler(vi.fn(async () => "failed" as const));

    await handler("this", ctx as never);

    expect(ctx.ui.notify).toHaveBeenCalledWith("Session retitle failed.", "error");
  });

  it("parses the supported direct variants and flexible -f ordering", () => {
    expect(parseRetitleCommand("folder", true)).toEqual({
      kind: "run",
      scope: "folder",
      mode: "backfill",
    });
    expect(parseRetitleCommand("pi", true)).toEqual({
      kind: "run",
      scope: "global",
      mode: "backfill",
    });
    expect(parseRetitleCommand("folder -f", true)).toEqual({
      kind: "run",
      scope: "folder",
      mode: "backfill",
      force: true,
    });
    expect(parseRetitleCommand("-f folder", true)).toEqual({
      kind: "run",
      scope: "folder",
      mode: "backfill",
      force: true,
    });
    expect(parseRetitleCommand("pi -f", true)).toEqual({
      kind: "run",
      scope: "global",
      mode: "backfill",
      force: true,
    });
    expect(parseRetitleCommand("-f pi", true)).toEqual({
      kind: "run",
      scope: "global",
      mode: "backfill",
      force: true,
    });
  });

  it("rejects unsupported direct variants", () => {
    expect(parseRetitleCommand("all", true)).toEqual({
      kind: "error",
      message: "Usage: /title [this|folder|pi] [-f]",
    });
    expect(parseRetitleCommand("global", true)).toEqual({
      kind: "error",
      message: "Usage: /title [this|folder|pi] [-f]",
    });
    expect(parseRetitleCommand("folder --force", true)).toEqual({
      kind: "error",
      message: "Usage: /title [this|folder|pi] [-f]",
    });
    expect(parseRetitleCommand("this -f", true)).toEqual({
      kind: "error",
      message: "Usage: /title [this|folder|pi] [-f]",
    });
    expect(parseRetitleCommand("folder pi", true)).toEqual({
      kind: "error",
      message: "Usage: /title [this|folder|pi] [-f]",
    });
  });

  it("offers slash-command argument completions for the canonical retitle flows", () => {
    expect(getRetitleArgumentCompletions("")?.map((item) => item.value)).toEqual([
      "this",
      "folder",
      "pi",
    ]);
    expect(getRetitleArgumentCompletions("p")?.map((item) => item.value)).toEqual(["pi"]);
  });
});

function createCommandContext(options: { hasUI: boolean }) {
  return {
    hasUI: options.hasUI,
    waitForIdle: vi.fn(async () => {}),
    ui: {
      notify: vi.fn(),
    },
  };
}
