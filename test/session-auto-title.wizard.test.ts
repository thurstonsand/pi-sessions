import type { Component, TuiMouseEvent } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { showRetitleWizard } from "../extensions/session-auto-title/wizard.ts";

vi.mock("../extensions/session-auto-title/retitle.ts", () => ({
  buildRetitleScopeScan: vi.fn(async (_ctx, scope) => ({
    scope,
    totalCount: 2,
    untitledCount: 1,
    sessions: [],
  })),
  buildScopeScanMessage: () => "Scanning",
  formatScopeLocation: () => "here",
  getEligibleSessions: () => [],
  buildBulkRetitleMessage: () => "Running",
  runBulkRetitle: vi.fn(),
  notifyBulkRetitleResult: vi.fn(),
  runRetitlePlan: vi.fn(),
}));

function mouse(type: TuiMouseEvent["type"], x: number, y: number, wheelDelta = 0): TuiMouseEvent {
  return {
    type,
    button: "left",
    x,
    y,
    screenX: x,
    screenY: y,
    width: 100,
    height: 30,
    shift: false,
    alt: false,
    ctrl: false,
    wheelDelta,
  };
}

function setup() {
  let panel!: Component;
  let title = "Short title";
  const done = vi.fn();
  const waitForIdle = vi.fn(() => new Promise<void>(() => {}));
  const theme = {
    fg: (_: string, text: string) => text,
    bg: (_: string, text: string) => `\x1b[44m${text}\x1b[49m`,
    bold: (text: string) => text,
  };
  const ctx = {
    ui: {
      custom: (
        factory: (tui: unknown, theme: unknown, kb: unknown, done: unknown) => Component,
      ) => {
        panel = factory({ requestRender: vi.fn() }, theme, {}, done);
      },
    },
    sessionManager: { getSessionName: () => title },
    waitForIdle,
  };
  void showRetitleWizard(
    {} as never,
    {
      getAutoRetitleStatus: () => ({ mode: "active", turnsUntilAutoRetitle: 2 }),
      getLastFailure: () => undefined,
    } as never,
    ctx as never,
    {} as never,
    undefined,
    () => 0,
    {} as never,
  );
  return {
    panel,
    done,
    waitForIdle,
    setTitle: (value: string) => {
      title = value;
    },
  };
}

function find(panel: Component, text: string) {
  const lines = panel.render(100);
  const y = lines.findIndex((line) => line.includes(text));
  expect(y).toBeGreaterThanOrEqual(0);
  return { x: lines[y]?.indexOf(text) ?? -1, y };
}

function click(panel: Component, text: string) {
  const { x, y } = find(panel, text);
  panel.handleMouse?.(mouse("press", x, y));
  panel.handleMouse?.(mouse("click", x, y));
}

describe("retitle wizard mouse", () => {
  it("selects on press and commits the original option after actual title reflow", async () => {
    const { panel, setTitle, waitForIdle } = setup();
    const { x, y } = find(panel, "Generate titles for all sessions in this folder");
    panel.handleMouse?.(mouse("press", x, y));
    expect(panel.render(100)[y]).toContain("› f");
    expect(waitForIdle).not.toHaveBeenCalled();
    setTitle("word ".repeat(22));
    const lines = panel.render(100);
    expect(lines[y]).toContain("Regenerate title for this session");
    expect(panel.handleMouse?.(mouse("release", x, y))).toEqual({ handled: true, render: true });
    panel.render(100);
    panel.handleMouse?.(mouse("click", x, y));
    await Promise.resolve();
    expect(panel.render(100).join("\n")).toContain("In This Folder");
    expect(waitForIdle).not.toHaveBeenCalled();
  });

  it("does not let a stale Enter gesture confirm the new destructive warning step", async () => {
    const { panel, waitForIdle } = setup();
    click(panel, "Generate titles for all sessions of Pi");
    await Promise.resolve();
    const { x, y } = find(panel, "Enter");
    panel.handleMouse?.(mouse("press", x, y));
    panel.handleInput?.("a");
    expect(panel.render(100).join("\n")).toContain("WARNING");
    expect(panel.render(100).join("\n")).not.toContain("\u001b[44m");
    panel.handleMouse?.(mouse("release", x, y));
    panel.render(100);
    panel.handleMouse?.(mouse("click", x, y));
    expect(waitForIdle).not.toHaveBeenCalled();
    click(panel, "Enter");
    expect(waitForIdle).toHaveBeenCalledOnce();
  });

  it("ignores hover and row padding, overwrites abandoned presses, and navigates by wheel", () => {
    const { panel, waitForIdle } = setup();
    const { x, y } = find(panel, "Regenerate title for this session");
    panel.handleMouse?.(mouse("press", x, y));
    expect(panel.handleMouse?.(mouse("press", 98, y))).toBeUndefined();
    panel.handleMouse?.(mouse("click", x, y));
    expect(waitForIdle).not.toHaveBeenCalled();
    const folder = find(panel, "Generate titles for all sessions in this folder");
    panel.handleMouse?.(mouse("move", folder.x, folder.y));
    expect(panel.render(100)[y]).toContain("› t");
    panel.handleMouse?.(mouse("wheel", folder.x, folder.y, 3));
    expect(panel.render(100)[folder.y]).toContain("› f");
  });

  it("highlights action text until release and retains its callback through rerender", async () => {
    const { panel, done } = setup();
    click(panel, "Generate titles for all sessions in this folder");
    await Promise.resolve();
    const { x, y } = find(panel, "Enter");
    panel.handleMouse?.(mouse("press", x, y));
    expect(panel.render(100)[y]).toContain(
      "│ \u001b[44mEnter Generate missing titles (1)\u001b[49m",
    );
    expect(panel.handleMouse?.(mouse("release", x, y))).toEqual({ handled: true, render: true });
    expect(panel.render(100).join("\n")).not.toContain("\u001b[44m");
    const cancel = find(panel, "Esc");
    panel.handleMouse?.(mouse("click", cancel.x, cancel.y));
    expect(panel.render(100).join("\n")).toContain("No untitled sessions");
    expect(done).not.toHaveBeenCalled();
  });

  it("drops dragged or replaced actions and keeps clipped controls inert", async () => {
    const { panel } = setup();
    click(panel, "Generate titles for all sessions in this folder");
    await Promise.resolve();
    const { x, y } = find(panel, "Enter");
    for (const event of [
      mouse("drag", x, y),
      mouse("press", 2, 1),
      mouse("press", 98, y),
      { ...mouse("press", x, y), button: "right" as const },
    ]) {
      panel.handleMouse?.(mouse("press", x, y));
      panel.handleMouse?.(event);
      expect(panel.render(100).join("\n")).not.toContain("\u001b[44m");
      panel.handleMouse?.(mouse("release", x, y));
      expect(panel.handleMouse?.(mouse("click", x, y))).toBeUndefined();
      expect(panel.render(100).join("\n")).toContain("Generate missing titles");
    }
    panel.render(15);
    expect(panel.handleMouse?.(mouse("press", x, y))).toBeUndefined();
    expect(panel.render(15).join("\n")).not.toContain("\u001b[44m");
  });

  it("clicks mode, empty close, and cancel hints", async () => {
    const first = setup();
    click(first.panel, "Generate titles for all sessions in this folder");
    await Promise.resolve();
    click(first.panel, "Enter");
    expect(first.panel.render(100).join("\n")).toContain("No untitled sessions");
    click(first.panel, "Enter");
    expect(first.done).toHaveBeenCalledWith("success");
    const second = setup();
    click(second.panel, "Generate titles for all sessions of Pi");
    await Promise.resolve();
    click(second.panel, "Regenerate all sessions");
    click(second.panel, "Esc");
    expect(second.done).toHaveBeenCalledWith("cancelled");
  });
});
