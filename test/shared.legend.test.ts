import type { Theme } from "@earendil-works/pi-coding-agent";
import { type TuiMouseEvent, visibleWidth } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { describe, expect, it, vi } from "vitest";
import { LegendPointer, layoutLegend, legendHitAt } from "../extensions/shared/legend.ts";

const theme = {
  fg: (_: string, text: string) => text,
  bg: (_: string, text: string) => `\u001b[44m${text}\u001b[49m`,
} as unknown as Theme;

function mouse(
  type: TuiMouseEvent["type"],
  button: TuiMouseEvent["button"] = "left",
): TuiMouseEvent {
  return {
    type,
    button,
    x: 1,
    y: 0,
    screenX: 1,
    screenY: 0,
    width: 80,
    height: 1,
    shift: false,
    alt: false,
    ctrl: false,
  };
}

describe("legend press feedback", () => {
  function setup() {
    const requestRender = vi.fn();
    const pointer = new LegendPointer(requestRender);
    const run = vi.fn();
    const render = (width = 80) =>
      layoutLegend(
        theme,
        [
          { key: "x", description: "stop", run },
          { key: "esc", description: "cancel", run: vi.fn() },
          { key: "↑↓", description: "move" },
        ],
        { width, pressedId: pointer.pressedId },
      );
    const hit = render().hits[0];
    if (!hit) throw new Error("Missing test action");
    return { pointer, render, hit, run, requestRender };
  }

  it("highlights only the actionable text until release, then clicks the original callback", () => {
    const { pointer, render, hit, run } = setup();
    pointer.handleMouse(mouse("press"), hit);
    expect(render().text).toBe("\u001b[44mx stop\u001b[49m  esc cancel  ↑↓ move");
    expect(run).not.toHaveBeenCalled();
    expect(pointer.handleMouse(mouse("release"), undefined)).toMatchObject({ render: true });
    expect(render().text).not.toContain("\u001b[44m");
    const replacement = vi.fn();
    pointer.handleMouse(mouse("click"), { ...hit, run: replacement });
    expect(run).toHaveBeenCalledOnce();
    expect(replacement).not.toHaveBeenCalled();
    pointer.handleMouse(mouse("click"), hit);
    expect(run).toHaveBeenCalledOnce();
  });

  it("does not highlight clipped hints or a different action using the same key", () => {
    const { pointer, render, hit } = setup();
    pointer.handleMouse(mouse("press"), hit);
    expect(render(6).text).not.toContain("\u001b[44m");
    const next = layoutLegend(theme, [{ key: "x", description: "confirm", run: vi.fn() }], {
      width: 80,
      pressedId: pointer.pressedId,
    });
    expect(next.text).toBe("x confirm");
    const direction = layoutLegend(theme, [{ key: "x", description: "stop" }], {
      width: 80,
      pressedId: pointer.pressedId,
    });
    expect(direction.text).toBe("x stop");
  });

  it("clears drag feedback and never resurrects the abandoned action on click", () => {
    const { pointer, render, hit, run } = setup();
    pointer.handleMouse(mouse("press"), hit);
    expect(pointer.handleMouse(mouse("drag"), undefined)).toMatchObject({ handled: true });
    expect(render().text).not.toContain("\u001b[44m");
    pointer.handleMouse(mouse("release"), hit);
    pointer.handleMouse(mouse("click"), hit);
    expect(run).not.toHaveBeenCalled();
  });

  it.each(["left", "right"] as const)(
    "clears feedback on an inert %s press without claiming text selection",
    (button) => {
      const { pointer, render, hit, run, requestRender } = setup();
      pointer.handleMouse(mouse("press"), hit);
      expect(
        pointer.handleMouse(mouse("press", button), button === "left" ? undefined : hit),
      ).toBeUndefined();
      expect(requestRender).toHaveBeenCalledOnce();
      expect(render().text).not.toContain("\u001b[44m");
      pointer.handleMouse(mouse("click"), hit);
      expect(run).not.toHaveBeenCalled();
    },
  );
});

describe("clickable legends", () => {
  it("keeps directions and separators inert", () => {
    const run = vi.fn();
    const { text, hits } = layoutLegend(
      theme,
      [
        { key: "↑↓", description: "move" },
        { key: "enter", description: "accept", run },
        { key: "esc", description: "cancel", run },
      ],
      { width: 80, separator: " · " },
    );
    expect(text).toBe("↑↓ move · enter accept · esc cancel");
    expect(legendHitAt(hits, 0)).toBeUndefined();
    expect(legendHitAt(hits, text.indexOf("·"))).toBeUndefined();
    legendHitAt(hits, text.indexOf("accept"))?.run();
    expect(run).toHaveBeenCalledOnce();
  });

  it("does not leave a target on the ellipsis or partially clipped hints", () => {
    const run = vi.fn();
    const { text, hits } = layoutLegend(
      theme,
      [
        { key: "x", description: "stop", run },
        { key: "esc", description: "cancel", run },
      ],
      { width: 6 },
    );
    expect(stripAnsi(text)).toBe("x sto…");
    expect(hits).toEqual([]);
  });

  it("accounts for wide characters and trailing text when clipping", () => {
    const run = vi.fn();
    const { text, hits } = layoutLegend(theme, [{ key: "x", description: "界", run }], {
      width: 4,
      trailing: "1 of 2",
    });
    expect(visibleWidth(text)).toBeLessThanOrEqual(4);
    expect(hits).toEqual([]);
    const full = layoutLegend(theme, [{ key: "x", description: "界", run }], { width: 4 });
    expect(full.hits).toMatchObject([{ start: 0, end: 4 }]);
    expect(legendHitAt(full.hits, 4)).toBeUndefined();
  });
});
