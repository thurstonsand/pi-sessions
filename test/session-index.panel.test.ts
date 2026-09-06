import type { Theme } from "@earendil-works/pi-coding-agent";
import { type TuiMouseEvent, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { SessionIndexPanel } from "../extensions/session-index/panel.ts";

const theme = {
  fg: (_: string, text: string) => text,
  bg: (_: string, text: string) => `\x1b[44m${text}\x1b[49m`,
  bold: (text: string) => text,
} as unknown as Theme;

function mouse(type: TuiMouseEvent["type"], x: number, y: number): TuiMouseEvent {
  return {
    type,
    button: "left",
    x,
    y,
    screenX: x,
    screenY: y,
    width: 72,
    height: 11,
    shift: false,
    alt: false,
    ctrl: false,
  };
}

function setup() {
  const done = vi.fn();
  const requestRender = vi.fn();
  const panel = new SessionIndexPanel(
    theme,
    { exists: false, dbPath: "/tmp/index.sqlite" },
    done,
    requestRender,
  );
  panel.render(72);
  return { panel, done, requestRender };
}

describe("session index panel mouse", () => {
  it.each([
    [8, "reindex"],
    [9, undefined],
  ] as const)("clicks action row %s only on release", (y, action) => {
    const { panel, done } = setup();
    panel.handleMouse(mouse("press", 2, y));
    expect(done).not.toHaveBeenCalled();
    expect(panel.render(72)[y]).toContain("\x1b[44m");
    expect(panel.handleMouse(mouse("release", 2, y))).toEqual({ handled: true, render: true });
    expect(panel.render(72).join("\n")).not.toContain("\x1b[44m");
    panel.handleMouse(mouse("click", 2, y === 8 ? 9 : 8));
    expect(done).toHaveBeenCalledExactlyOnceWith(action);
  });

  it("clears highlight and captured identity on drag or any inert or secondary press", () => {
    const { panel, done, requestRender } = setup();
    for (const event of [
      mouse("drag", 2, 9),
      mouse("press", 2, 3),
      mouse("press", 40, 8),
      { ...mouse("press", 2, 8), button: "right" as const },
    ]) {
      panel.handleMouse(mouse("press", 2, 8));
      expect(panel.render(72)[8]).toContain("\x1b[44mR rebuild from disk\x1b[49m");
      expect(panel.handleMouse(event)).toEqual(
        event.type === "drag" ? { handled: true } : undefined,
      );
      expect(panel.render(72).join("\n")).not.toContain("\x1b[44m");
      panel.handleMouse(mouse("release", 2, 8));
      expect(panel.handleMouse(mouse("click", 2, 8))).toBeUndefined();
    }
    expect(done).not.toHaveBeenCalled();
    expect(requestRender).toHaveBeenCalledTimes(3);
  });

  it("retains its pressed action across resize but clears abandoned presses", () => {
    const { panel, done } = setup();
    panel.handleMouse(mouse("press", 2, 8));
    const narrow = panel.render(14);
    expect(narrow.every((line) => visibleWidth(line) <= 14)).toBe(true);
    expect(narrow[8]).not.toContain("rebuild from disk");
    panel.handleMouse(mouse("click", 2, 8));
    expect(done).toHaveBeenCalledExactlyOnceWith("reindex");
    done.mockClear();
    panel.render(72);
    panel.handleMouse(mouse("press", 2, 8));
    expect(panel.handleMouse(mouse("press", 40, 8))).toBeUndefined();
    panel.handleMouse(mouse("click", 2, 8));
    expect(done).not.toHaveBeenCalled();
  });

  it("ignores text, borders, padding, hover and hidden controls", () => {
    const { panel, done } = setup();
    for (const [x, y] of [
      [2, 3],
      [0, 8],
      [25, 8],
    ] as const) {
      expect(panel.handleMouse(mouse("press", x, y))).toBeUndefined();
      expect(panel.handleMouse(mouse("click", x, y))).toBeUndefined();
    }
    expect(panel.handleMouse(mouse("move", 2, 8))).toBeUndefined();
    panel.render(10);
    expect(panel.handleMouse(mouse("press", 2, 8))).toBeUndefined();
    expect(done).not.toHaveBeenCalled();
  });

  it.each([
    ["R", "reindex"],
    ["r", "reindex"],
    ["\r", undefined],
    ["\u001b", undefined],
  ] as const)("preserves keyboard action %s", (key, action) => {
    const { panel, done } = setup();
    panel.handleInput(key);
    expect(done).toHaveBeenCalledExactlyOnceWith(action);
  });
});
