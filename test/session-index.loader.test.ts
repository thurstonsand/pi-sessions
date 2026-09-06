import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { ReindexLoader } from "../extensions/session-index/loader.ts";

function setup() {
  const cancel = vi.fn();
  const theme = {
    fg: (_: string, text: string) => text,
    bg: (_: string, text: string) => `\x1b[44m${text}\x1b[49m`,
  } as unknown as Theme;
  const keys = {
    getKeys: () => ["alt+q"],
    matches: (data: string, action: string) =>
      action === "tui.select.cancel" && matchesKey(data, "alt+q"),
  } as unknown as KeybindingsManager;
  const loader = new ReindexLoader(
    { requestRender: vi.fn() } as unknown as TUI,
    theme,
    keys,
    cancel,
  );
  return { loader, cancel };
}

function mouse(type: TuiMouseEvent["type"], x: number, y: number): TuiMouseEvent {
  return {
    type,
    button: "left",
    x,
    y,
    screenX: x,
    screenY: y,
    width: 72,
    height: 7,
    shift: false,
    alt: false,
    ctrl: false,
  };
}

describe("reindex loader mouse", () => {
  it("runs the configured cancel hint after a press and release across reflow", () => {
    const { loader, cancel } = setup();
    try {
      const lines = loader.render(72);
      const y = lines.findIndex((line) => line.includes("alt+q cancel"));
      expect(y).toBeGreaterThan(0);
      loader.handleMouse(mouse("press", 1, y));
      expect(cancel).not.toHaveBeenCalled();
      expect(loader.render(72)[y]).toContain("\u001b[44malt+q cancel\u001b[49m");
      expect(loader.handleMouse(mouse("release", 1, y))).toEqual({ handled: true, render: true });
      expect(loader.render(72).join("\n")).not.toContain("\u001b[44m");
      const after = loader.render(14);
      expect(after.findIndex((line) => line.includes("alt+q cancel"))).not.toBe(y);
      loader.handleMouse(mouse("click", 1, y));
      expect(cancel).toHaveBeenCalledOnce();
    } finally {
      loader.dispose();
    }
  });

  it("drops dragged or replaced gestures without re-resolving the cancel hint", () => {
    const { loader, cancel } = setup();
    try {
      const y = loader.render(72).findIndex((line) => line.includes("cancel"));
      for (const event of [
        mouse("drag", 1, y),
        mouse("press", 1, 1),
        mouse("press", 0, y),
        { ...mouse("press", 1, y), button: "middle" as const },
      ]) {
        loader.handleMouse(mouse("press", 1, y));
        loader.handleMouse(event);
        expect(loader.render(72).join("\n")).not.toContain("\u001b[44m");
        loader.handleMouse(mouse("release", 1, y));
        expect(loader.handleMouse(mouse("click", 1, y))).toBeUndefined();
      }
      expect(cancel).not.toHaveBeenCalled();
    } finally {
      loader.dispose();
    }
  });

  it("does not activate padding, stale presses or clipped hints", () => {
    const { loader, cancel } = setup();
    try {
      const y = loader.render(72).findIndex((line) => line.includes("cancel"));
      loader.handleMouse(mouse("press", 1, y));
      expect(loader.handleMouse(mouse("press", 40, y))).toBeUndefined();
      loader.handleMouse(mouse("click", 1, y));
      expect(loader.handleMouse(mouse("press", 1, 2))).toBeUndefined();
      expect(loader.handleMouse(mouse("move", 1, y))).toBeUndefined();
      loader.render(8);
      expect(loader.handleMouse(mouse("press", 1, y))).toBeUndefined();
      expect(cancel).not.toHaveBeenCalled();
      loader.handleInput("\u001bq");
      expect(cancel).toHaveBeenCalledOnce();
    } finally {
      loader.dispose();
    }
  });
});
