import { describe, expect, it, vi } from "vitest";
import {
  HandoffPreviewComponent,
  reviewHandoffDraft,
} from "../extensions/session-handoff/review.js";

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

  it("returns the edited draft after preview edit mode", async () => {
    const result = await reviewHandoffDraft(
      {
        ui: {
          async custom() {
            return "edit";
          },
          async editor() {
            return "Edited draft";
          },
        },
      } as never,
      "Original draft",
    );

    expect(result).toBe("Edited draft");
  });

  it("returns undefined when the review is cancelled", async () => {
    const result = await reviewHandoffDraft(
      {
        ui: {
          async custom() {
            return "cancel";
          },
          async editor() {
            throw new Error("editor should not run");
          },
        },
      } as never,
      "Original draft",
    );

    expect(result).toBeUndefined();
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
  } as never;
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
