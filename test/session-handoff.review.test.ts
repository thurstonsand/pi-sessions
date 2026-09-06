import type { Theme } from "@earendil-works/pi-coding-agent";
import type { TuiMouseEvent } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { HandoffPreviewComponent } from "../extensions/session-handoff/review.ts";

describe("session handoff review", () => {
  it("accepts the draft automatically when the timer expires", () => {
    const clock = createTestClock();
    const onDone = vi.fn();
    const preview = new HandoffPreviewComponent("Draft text", createTheme(), vi.fn(), onDone, {
      timeoutMs: 8_000,
      clock,
    });

    clock.advance(8_000);

    expect(onDone).toHaveBeenCalledWith("accept");
    preview.stop();
  });

  it("renders a filled modal with an inner prompt box", () => {
    const preview = new HandoffPreviewComponent("Draft text", createTheme(), vi.fn(), vi.fn(), {
      clock: createTestClock(),
    });

    const lines = preview.render(60);

    expect(lines.some((line) => line.includes("Handoff preview"))).toBe(true);
    expect(lines.some((line) => line.includes("┌"))).toBe(true);
    expect(lines.some((line) => line.includes("└"))).toBe(true);
    preview.stop();
  });

  it("accepts immediately when Enter is pressed", () => {
    const onDone = vi.fn();
    const preview = new HandoffPreviewComponent("Draft text", createTheme(), vi.fn(), onDone, {
      clock: createTestClock(),
    });

    preview.handleInput("\r");

    expect(onDone).toHaveBeenCalledWith("accept");
    preview.stop();
  });

  it("enters edit mode when e is pressed", () => {
    const onDone = vi.fn();
    const preview = new HandoffPreviewComponent("Draft text", createTheme(), vi.fn(), onDone, {
      clock: createTestClock(),
    });

    preview.handleInput("e");

    expect(onDone).toHaveBeenCalledWith("edit");
    preview.stop();
  });

  it("stops auto-send when the user scrolls with j/k", () => {
    const clock = createTestClock();
    const onDone = vi.fn();
    const preview = new HandoffPreviewComponent(
      Array.from({ length: 40 }, (_, index) => `Line ${index + 1}`).join("\n"),
      createTheme(),
      vi.fn(),
      onDone,
      { clock },
    );

    preview.render(40);
    preview.handleInput("j");
    clock.advance(20_000);

    expect(onDone).not.toHaveBeenCalled();
    expect(preview.render(40).join("\n")).toContain("Handoff preview");
    expect(preview.render(40).join("\n")).not.toContain("(8s)");
    preview.stop();
  });

  it("cancels when Escape is pressed", () => {
    const onDone = vi.fn();
    const preview = new HandoffPreviewComponent("Draft text", createTheme(), vi.fn(), onDone, {
      clock: createTestClock(),
    });

    preview.handleInput("\u001b");

    expect(onDone).toHaveBeenCalledWith("cancel");
    preview.stop();
  });
});

function createTheme() {
  return {
    fg(_color: string, text: string) {
      return text;
    },
    bg(_color: string, text: string) {
      return text;
    },
    bold(text: string) {
      return text;
    },
  } as unknown as Theme;
}

function createTestClock() {
  let now = 0;
  const callbacks = new Set<() => void>();

  return {
    now() {
      return now;
    },
    setInterval(callback: () => void) {
      callbacks.add(callback);
      return {
        stop() {
          callbacks.delete(callback);
        },
      };
    },
    advance(ms: number) {
      now += ms;
      for (const callback of callbacks) {
        callback();
      }
    },
  };
}

function mouse(type: TuiMouseEvent["type"], x: number, y: number, wheelDelta = 0): TuiMouseEvent {
  return {
    type,
    button: "left",
    x,
    y,
    screenX: x,
    screenY: y,
    width: 80,
    height: 30,
    shift: false,
    alt: false,
    ctrl: false,
    wheelDelta,
  };
}

describe("handoff review mouse", () => {
  it("highlights the held hint, then clears it before committing the retained action", () => {
    const theme = createTheme();
    const background = vi.spyOn(theme, "bg");
    const onDone = vi.fn();
    const clock = createTestClock();
    const preview = new HandoffPreviewComponent("Draft", theme, vi.fn(), onDone, { clock });
    try {
      preview.render(80);
      preview.handleMouse(mouse("press", 3, 3));
      background.mockClear();
      preview.render(80);
      expect(background).toHaveBeenCalledWith("selectedBg", "Enter: start session");
      clock.advance(9_000);
      expect(onDone).not.toHaveBeenCalled();
      expect(preview.handleMouse(mouse("release", 3, 3))).toMatchObject({ render: true });
      background.mockClear();
      preview.render(80);
      expect(background).not.toHaveBeenCalledWith("selectedBg", "Enter: start session");
      preview.handleMouse(mouse("click", 3, 3));
      expect(onDone).toHaveBeenCalledExactlyOnceWith("accept");
    } finally {
      preview.stop();
    }
  });

  it("clears held hint feedback on drag without activating it", () => {
    const theme = createTheme();
    const background = vi.spyOn(theme, "bg");
    const onDone = vi.fn();
    const preview = new HandoffPreviewComponent("Draft", theme, vi.fn(), onDone, {
      clock: createTestClock(),
    });
    try {
      preview.render(80);
      preview.handleMouse(mouse("press", 3, 3));
      preview.render(80);
      preview.handleMouse(mouse("drag", 8, 3));
      background.mockClear();
      preview.render(80);
      expect(background).not.toHaveBeenCalledWith("selectedBg", "Enter: start session");
      preview.handleMouse(mouse("release", 8, 3));
      preview.handleMouse(mouse("click", 3, 3));
      expect(onDone).not.toHaveBeenCalled();
    } finally {
      preview.stop();
    }
  });
  it.each([
    ["Enter: start session", "accept"],
    ["Esc: cancel", "cancel"],
    ["e: edit prompt", "edit"],
  ])("clicks %s only on release", (label, action) => {
    const onDone = vi.fn();
    const clock = createTestClock();
    const preview = new HandoffPreviewComponent("Draft", createTheme(), vi.fn(), onDone, { clock });
    const lines = preview.render(80);
    const y = lines.findIndex((line) => line.includes(label));
    const x = lines[y]?.indexOf(label) ?? -1;
    preview.handleMouse(mouse("press", x, y));
    clock.advance(9_000);
    expect(onDone).not.toHaveBeenCalled();
    preview.render(80);
    preview.handleMouse(mouse("click", x, y));
    expect(onDone).toHaveBeenCalledWith(action);
    preview.stop();
  });

  it("retains a pressed hint across resize and consumes it once", () => {
    const onDone = vi.fn();
    const preview = new HandoffPreviewComponent("Draft", createTheme(), vi.fn(), onDone, {
      clock: createTestClock(),
    });
    preview.render(80);
    preview.handleMouse(mouse("press", 30, 3));
    expect(preview.render(24).join("\n")).not.toContain("Esc: cancel");
    preview.handleMouse(mouse("click", 30, 3));
    preview.handleMouse(mouse("click", 30, 3));
    expect(onDone).toHaveBeenCalledExactlyOnceWith("cancel");
    preview.stop();
  });

  it("leaves text selection, gaps, directions, hover and clipped hints inert", () => {
    const onDone = vi.fn();
    const preview = new HandoffPreviewComponent("Draft", createTheme(), vi.fn(), onDone, {
      clock: createTestClock(),
    });
    preview.render(80);
    for (const [x, y] of [
      [25, 3],
      [30, 4],
      [5, 7],
    ] as const) {
      preview.handleMouse(mouse("press", 3, 3));
      expect(preview.handleMouse(mouse("press", x, y))).toBeUndefined();
      preview.handleMouse(mouse("click", 3, 3));
    }
    expect(preview.handleMouse(mouse("move", 3, 3))).toBeUndefined();
    preview.render(24);
    expect(preview.handleMouse(mouse("press", 30, 3))).toBeUndefined();
    expect(onDone).not.toHaveBeenCalled();
    preview.stop();
  });

  it("scrolls with the wheel and disables autostart", () => {
    const clock = createTestClock();
    const onDone = vi.fn();
    const preview = new HandoffPreviewComponent(
      Array.from({ length: 40 }, (_, i) => `Line ${i}`).join("\n"),
      createTheme(),
      vi.fn(),
      onDone,
      { clock },
    );
    preview.render(80);
    preview.handleMouse(mouse("wheel", 5, 8, 2));
    const lines = preview.render(80).join("\n");
    expect(lines).not.toContain("Line 0 ");
    expect(lines).toContain("Line 2 ");
    clock.advance(20_000);
    expect(onDone).not.toHaveBeenCalled();
    preview.stop();
  });
});
