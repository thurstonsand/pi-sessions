import type {
  ExtensionUIContext,
  KeybindingsManager,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { Component, TUI, TuiMouseEvent } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { runHandoffTaskWithLoader } from "../extensions/session-handoff/ui.ts";

function mouse(type: TuiMouseEvent["type"], x: number, y: number): TuiMouseEvent {
  return {
    type,
    button: "left",
    x,
    y,
    screenX: x,
    screenY: y,
    width: 80,
    height: 5,
    shift: false,
    alt: false,
    ctrl: false,
  };
}

function setup() {
  let panel: Component | undefined;
  let signal: AbortSignal | undefined;
  const requestRender = vi.fn();
  const theme = {
    fg: (_: string, text: string) => text,
    bg: (color: string, text: string) =>
      color === "selectedBg" ? `\x1b[44m${text}\x1b[49m` : text,
    bold: (text: string) => text,
  } as unknown as Theme;
  const ui = {
    custom: (
      factory: (
        tui: TUI,
        theme: Theme,
        kb: KeybindingsManager,
        done: (result: unknown) => void,
      ) => Component,
    ) =>
      new Promise((resolve) => {
        panel = factory(
          { requestRender } as unknown as TUI,
          theme,
          {} as KeybindingsManager,
          resolve,
        );
      }),
  } as unknown as ExtensionUIContext;
  const result = runHandoffTaskWithLoader({ ui }, "Generating handoff", (abortSignal) => {
    signal = abortSignal;
    return new Promise<string>(() => {});
  });
  if (!panel || !signal) throw new Error("Loader factory did not run");
  return { panel, signal, result };
}

describe("handoff loader mouse", () => {
  it("cancels and aborts the task when the visible hint is clicked", async () => {
    const { panel, signal, result } = setup();
    const lines = panel.render(80);
    const x = (lines[3] ?? "").indexOf("Esc");
    expect(x).toBe(8);
    panel.handleMouse?.(mouse("press", x, 3));
    expect(signal.aborted).toBe(false);
    expect(panel.render(40)[3]).toContain("Press \u001b[44mEsc to cancel.\u001b[49m");
    expect(panel.handleMouse?.(mouse("release", x, 3))).toEqual({ handled: true, render: true });
    expect(panel.render(40).join("\n")).not.toContain("\u001b[44m");
    panel.handleMouse?.(mouse("click", 0, 1));
    expect(signal.aborted).toBe(true);
    await expect(result).resolves.toBeUndefined();
  });

  it("clears feedback and cancellation identity on drag, inert and secondary presses", () => {
    const { panel, signal } = setup();
    panel.render(80);
    for (const event of [
      mouse("drag", 8, 3),
      mouse("press", 8, 1),
      mouse("press", 7, 3),
      mouse("press", 22, 3),
      { ...mouse("press", 8, 3), button: "right" as const },
    ]) {
      panel.handleMouse?.(mouse("press", 8, 3));
      expect(panel.render(80)[3]).toContain("\u001b[44m");
      panel.handleMouse?.(event);
      expect(panel.render(80).join("\n")).not.toContain("\u001b[44m");
      panel.handleMouse?.(mouse("release", 8, 3));
      expect(panel.handleMouse?.(mouse("click", 8, 3))).toBeUndefined();
    }
    expect(signal.aborted).toBe(false);
  });

  it("keeps the label and padding inert and forgets abandoned presses", async () => {
    const { panel, signal, result } = setup();
    panel.render(80);
    panel.handleMouse?.(mouse("press", 8, 3));
    expect(panel.handleMouse?.(mouse("press", 40, 3))).toBeUndefined();
    panel.handleMouse?.(mouse("click", 8, 3));
    expect(panel.handleMouse?.(mouse("press", 8, 1))).toBeUndefined();
    expect(panel.handleMouse?.(mouse("move", 8, 3))).toBeUndefined();
    expect(signal.aborted).toBe(false);
    panel.handleInput?.("\u001b");
    await expect(result).resolves.toBeUndefined();
    expect(signal.aborted).toBe(true);
  });
});
