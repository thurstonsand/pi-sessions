import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { type TuiMouseEvent, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import {
  collectUserSessions,
  HandoffBoard,
  type HandoffBoardSnapshot,
  loadHandoffBoardSnapshot,
} from "../extensions/session-handoff/board.ts";
import type { SubagentRosterEntry } from "../extensions/subagents/roster.ts";

const now = Date.parse("2026-03-25T12:20:00.000Z");
const ownerSessionId = "12345678-1234-1234-1234-123456789abc";
const theme = {
  bold: (text: string) => text,
  italic: (text: string) => text,
  strikethrough: (text: string) => text,
  fg: (_token: string, text: string) => text,
  bg: (_token: string, text: string) => text,
};

describe("handoff board", () => {
  it("renders the quiet aligned grid and keeps wide titles within the component width", () => {
    const board = createBoard(
      snapshot([
        subagent("child-1", "Lifecycle 恢復 probe", "busy", {
          tmuxWindowId: "@1",
          managedLive: true,
        }),
        subagent("child-2", "Nested API investigator", "completed", { depth: 2 }),
      ]),
    );

    const lines = board.render(78);

    expect(lines.join("\n")).toContain("Handoffs");
    expect(lines.join("\n")).toContain("2 on branch");
    expect(lines).toContainEqual(expect.stringContaining("Subagent"));
    expect(lines).toContainEqual(expect.stringContaining("› ● Lifecycle 恢復 probe"));
    expect(lines).toContainEqual(expect.stringContaining("    ○ Nested API investigator"));
    expect(lines).toContainEqual(expect.stringContaining("┌─ Details "));
    expect(lines).toContainEqual(expect.stringContaining("a copy observe"));
    expect(lines.every((line) => visibleWidth(line) <= 78)).toBe(true);

    const rows = lines.filter((line) => line.includes("Lifecycle") || line.includes("Nested"));
    const busyColumn = visibleWidth(rows[0]?.slice(0, rows[0].indexOf("busy")) ?? "");
    const completedColumn = visibleWidth(rows[1]?.slice(0, rows[1].indexOf("completed")) ?? "");
    expect(busyColumn).toBe(completedColumn);
  });

  it("uses a bordered modal and selected-row background", () => {
    const fg = vi.fn((_token: string, text: string) => text);
    const bg = vi.fn((_token: string, text: string) => text);
    const board = createBoard(snapshot([subagent("child-1", "Worker", "busy")]), {
      boardTheme: { ...theme, fg, bg },
    });

    const lines = board.render(78);

    expect(lines[0]).toMatch(/^╭─+╮$/);
    expect(lines.at(-1)).toMatch(/^╰─+╯$/);
    expect(fg).toHaveBeenCalledWith("border", expect.any(String));
    expect(fg).toHaveBeenCalledWith("success", expect.stringContaining("Details"));
    expect(bg).toHaveBeenCalledWith("selectedBg", expect.any(String));
    expect(bg).not.toHaveBeenCalledWith("customMessageBg", expect.any(String));
  });

  it("aligns Status identically across both lists", () => {
    const board = createBoard(
      snapshot(
        [subagent("child-1", "Worker", "busy")],
        [userSession("user-1", "User-owned session", "deferred", "2026-03-25T12:10:00.000Z")],
      ),
    );

    const subagentLines = board.render(86);
    const subagentHeader = subagentLines.find(
      (line) => line.includes("Subagent") && line.includes("Status"),
    );
    const subagentRow = subagentLines.find((line) => line.includes("Worker"));

    board.handleInput("\t");
    const userSessionLines = board.render(86);
    const userSessionHeader = userSessionLines.find(
      (line) => line.includes("Session") && line.includes("Status"),
    );
    const userSessionRow = userSessionLines.find((line) => line.includes("User-owned session"));

    expect(subagentHeader?.indexOf("Status")).toBe(userSessionHeader?.indexOf("Status"));
    expect(subagentRow?.indexOf("busy")).toBe(userSessionRow?.indexOf("ready"));
  });

  it("supports clamped h/j/k/l navigation without changing the legend", () => {
    const board = createBoard(
      snapshot(
        [
          subagent("child-1", "First worker", "completed"),
          subagent("child-2", "Second worker", "completed"),
        ],
        [userSession("user-1", "User-owned session", "deferred", "2026-03-25T12:10:00.000Z")],
      ),
    );

    board.handleInput("j");
    expect(board.render(86).find((line) => line.includes("Second worker"))).toContain("›");
    board.handleInput("j");
    expect(board.render(86).find((line) => line.includes("Second worker"))).toContain("›");
    board.handleInput("k");
    expect(board.render(86).find((line) => line.includes("First worker"))).toContain("›");

    board.handleInput("l");
    expect(board.render(86).join("\n")).toContain("User-owned session");
    board.handleInput("h");
    const output = board.render(86).join("\n");
    expect(output).toContain("First worker");
    expect(output).toContain("<> tab");
    expect(output).not.toContain("h/j/k/l");
  });

  it("keeps selection within an eight-row viewport", () => {
    const workers = Array.from({ length: 10 }, (_, index) =>
      subagent(`child-${index + 1}`, `Worker ${index + 1}`, "completed"),
    );
    const board = createBoard(snapshot(workers));

    expect(board.render(86).join("\n")).toContain("Worker 8");
    expect(board.render(86).join("\n")).not.toContain("Worker 9");

    for (let index = 0; index < 8; index += 1) {
      board.handleInput("j");
    }

    const scrolled = board.render(86).join("\n");
    expect(scrolled).not.toContain("Worker 1 ");
    expect(scrolled).toContain("Worker 9");
    expect(scrolled).toContain("9 of 10");
  });

  it("toggles tabs with tab or shift-tab from either screen", () => {
    const board = createBoard(
      snapshot(
        [],
        [userSession("one", "Only user session", "deferred", "2026-03-25T12:10:00.000Z")],
      ),
    );

    board.handleInput("\t");
    expect(board.render(78).join("\n")).toContain("Only user session");

    board.handleInput("\t");
    expect(board.render(78).join("\n")).toContain("No subagents on the active branch");

    board.handleInput("\u001b[Z");
    expect(board.render(78).join("\n")).toContain("Only user session");

    board.handleInput("\u001b[Z");
    expect(board.render(78).join("\n")).toContain("No subagents on the active branch");
    expect(board.render(78).join("\n")).toContain("<> tab");
  });

  it("switches tabs and renders user sessions newest first", () => {
    const board = createBoard(
      snapshot(
        [],
        [
          userSession("new", "Newest handoff", "deferred", "2026-03-25T12:19:00.000Z"),
          userSession("old", "Older handoff", "right", "2026-03-25T12:10:00.000Z"),
        ],
      ),
    );

    board.handleInput("\u001b[C");
    const output = board.render(78).join("\n");

    expect(output).toContain("2 user sessions");
    expect(output.indexOf("Newest handoff")).toBeLessThan(output.indexOf("Older handoff"));
    expect(output).toContain("c copy resume");
    expect(output).not.toContain("pi --session-id");
  });

  it("closes with q without changing the legend", () => {
    const done = vi.fn();
    const board = createBoard(snapshot([]), { done });

    expect(board.render(78).join("\n")).toContain("esc close");
    expect(board.render(78).join("\n")).not.toContain("q close");
    board.handleInput("q");

    expect(done).toHaveBeenCalledOnce();
  });

  it("copies a tmux observe command for stamped windows", async () => {
    const copy = vi.fn(async () => {});
    const board = createBoard(
      snapshot([
        subagent("child-1", "Worker", "starting", {
          managedLive: true,
          tmuxWindowId: "@7",
        }),
      ]),
      { copy },
    );

    board.handleInput("a");

    const action = process.env.TMUX ? "switch-client" : "attach-session";
    await vi.waitFor(() =>
      expect(copy).toHaveBeenCalledWith(`tmux ${action} -t 'pi-123456781234:@7'`),
    );
  });

  it("withholds recovery actions when runtime liveness is unavailable", () => {
    const initial = snapshot(
      [],
      [userSession("deferred", "Deferred handoff", "deferred", "2026-03-25T12:10:00.000Z")],
    );
    initial.hasLiveSessionEvidence = false;
    const board = createBoard(initial);

    board.handleInput("\u001b[C");
    const output = board.render(78).join("\n");

    expect(output).toContain("ready");
    expect(output).not.toContain("c copy resume");
  });

  it("renders durable startup evidence as closed after refresh", async () => {
    const entry = userSession(
      "user-1",
      "Observed user session",
      "right",
      "2026-03-25T12:10:00.000Z",
    );
    const initial = snapshot([], [entry]);
    initial.liveSessionIds = new Set([entry.sessionId]);
    const refreshed = snapshot(
      [],
      [
        {
          ...entry,
          runEvidence: { transcriptAvailable: true, hasStarted: true },
        },
      ],
    );
    const board = createBoard(initial, { refresh: async () => refreshed });

    board.handleInput("l");
    expect(board.render(86).join("\n")).toContain("live");

    board.handleInput("r");
    await vi.waitFor(() => expect(board.render(86).join("\n")).toContain("closed"));
  });

  it("confirms stop inline before cancelling and refreshing", async () => {
    const stop = vi.fn(async () => {});
    const refresh = vi.fn(async () => snapshot([subagent("child-1", "Worker", "stopped")]));
    const board = createBoard(
      snapshot([subagent("child-1", "Worker", "busy", { managedLive: true })]),
      {
        stop,
        refresh,
      },
    );

    board.handleInput("x");
    expect(stop).not.toHaveBeenCalled();
    expect(board.render(78).join("\n")).toContain("Stop “Worker”?  x confirm  ·  esc cancel");

    board.handleInput("x");
    await vi.waitFor(() => expect(stop).toHaveBeenCalledWith("child-1"));
    await vi.waitFor(() => expect(refresh).toHaveBeenCalled());
    expect(board.render(78).join("\n")).toContain("stopped");
  });

  it("dismisses copied-command feedback after three seconds or on the next key", async () => {
    const scheduled: Array<() => void> = [];
    const done = vi.fn();
    const board = createBoard(
      snapshot([
        subagent("child-1", "Worker", "starting", {
          managedLive: true,
          tmuxWindowId: "@7",
        }),
      ]),
      {
        copy: async () => {},
        done,
        schedule: (callback, delayMs) => {
          expect(delayMs).toBe(3_000);
          scheduled.push(callback);
        },
      },
    );

    board.handleInput("a");
    await vi.waitFor(() => expect(board.render(78).join("\n")).toContain("Observe command copied"));
    expect(board.render(78).join("\n")).not.toContain("press any navigation key");

    scheduled.shift()?.();
    expect(board.render(78).join("\n")).toContain("a copy observe");

    board.handleInput("a");
    await vi.waitFor(() => expect(board.render(78).join("\n")).toContain("Observe command copied"));
    board.handleInput(".");
    expect(board.render(78).join("\n")).toContain("a copy observe");

    board.handleInput("a");
    await vi.waitFor(() => expect(board.render(78).join("\n")).toContain("Observe command copied"));
    board.handleInput("\u001b");
    expect(done).toHaveBeenCalledOnce();
  });

  it("offers resume only without live evidence and copies the persisted command", async () => {
    const copy = vi.fn(async () => {});
    const board = createBoard(snapshot([subagent("child-1", "Worker", "interrupted")]), { copy });

    const before = board.render(78).join("\n");
    expect(before).toContain("c copy resume");
    expect(before).not.toContain("pi --session-id");
    expect(before).not.toContain("x stop");
    expect(before).not.toContain("a copy observe");

    board.handleInput("c");
    await vi.waitFor(() => expect(copy).toHaveBeenCalledWith("pi --session-id 'child-1'"));
  });
});

describe("handoff board mouse", () => {
  it("highlights action text while held and clears release feedback without losing its action", () => {
    const bg = vi.fn((_token: string, text: string) => text);
    const board = createBoard(
      snapshot([subagent("child", "Worker", "busy", { managedLive: true, tmuxWindowId: "@1" })]),
      { boardTheme: { ...theme, bg } },
    );
    const point = pointAt(board.render(86), "x stop");
    board.handleMouse(mouse("press", point));
    bg.mockClear();
    expect(board.render(86).join("\n")).not.toContain("x confirm");
    expect(bg).toHaveBeenCalledWith("selectedBg", "x stop");
    expect(board.handleMouse(mouse("release", point))).toMatchObject({ render: true });
    bg.mockClear();
    board.render(86);
    expect(bg).not.toHaveBeenCalledWith("selectedBg", "x stop");
    board.handleMouse(mouse("click", point));
    expect(board.render(86).join("\n")).toContain("x confirm");
  });

  it("does not paint an old stop gesture onto the confirmation that reuses its key", () => {
    const bg = vi.fn((_token: string, text: string) => text);
    const stop = vi.fn(async () => {});
    const board = createBoard(
      snapshot([subagent("child", "Worker", "busy", { managedLive: true, tmuxWindowId: "@1" })]),
      { stop, boardTheme: { ...theme, bg } },
    );
    const point = pointAt(board.render(86), "x stop");
    board.handleMouse(mouse("press", point));
    board.handleInput("x");
    bg.mockClear();
    expect(board.render(86).join("\n")).toContain("x confirm");
    expect(bg).not.toHaveBeenCalledWith("selectedBg", "x confirm");
    board.handleMouse(mouse("click", point));
    expect(stop).not.toHaveBeenCalled();
  });

  it("highlights tab labels while held and abandons feedback on a text press", () => {
    const bg = vi.fn((_token: string, text: string) => text);
    const board = createBoard(snapshot([]), { boardTheme: { ...theme, bg } });
    const point = pointAt(board.render(86), "User sessions");
    board.handleMouse(mouse("press", point));
    bg.mockClear();
    board.render(86);
    expect(bg).toHaveBeenCalledWith("selectedBg", "User sessions");
    const text = pointAt(board.render(86), "Handoffs");
    expect(board.handleMouse(mouse("press", text))).toBeUndefined();
    bg.mockClear();
    board.render(86);
    expect(bg).not.toHaveBeenCalledWith("selectedBg", "User sessions");
  });
  it("selects on press and retains the row through a real viewport reflow", () => {
    const copy = vi.fn(async () => {});
    const stop = vi.fn(async () => {});
    const board = createBoard(
      snapshot(
        Array.from({ length: 10 }, (_, index) =>
          subagent(`child-${index}`, `Worker ${index}`, "completed"),
        ),
      ),
      { copy, stop },
    );
    for (let index = 0; index < 9; index += 1) board.handleInput("j");
    const before = board.render(86);
    const point = pointAt(before, "Worker 2");

    expect(board.handleMouse(mouse("press", point))).toMatchObject({ handled: true, focus: true });
    const reflowed = board.render(86);
    expect(reflowed[point.y]).toContain("Worker 0");
    expect(reflowed.find((line) => line.includes("Worker 2"))).toContain("›");
    board.handleMouse(mouse("release", point));
    board.handleMouse(mouse("click", point));

    expect(board.render(86).find((line) => line.includes("Worker 2"))).toContain("›");
    expect(copy).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
    board.handleMouse(mouse("click", pointAt(board.render(86), "Worker 0")));
    expect(board.render(86).find((line) => line.includes("Worker 2"))).toContain("›");
  });

  it("retains session identity across a refreshed, reordered snapshot", async () => {
    const first = subagent("first", "First worker", "completed");
    const second = subagent("second", "Second worker", "completed");
    const board = createBoard(snapshot([first, second]), {
      refresh: async () => snapshot([second, first]),
    });
    const point = pointAt(board.render(86), "Second worker");
    board.handleMouse(mouse("press", point));
    board.handleInput("r");
    await vi.waitFor(() => expect(board.render(86).join("\n")).toContain("Refreshed"));
    expect(board.render(86)[point.y]).toContain("First worker");

    board.handleMouse(mouse("click", point));

    expect(board.render(86).find((line) => line.includes("Second worker"))).toContain("›");
  });

  it("does not select a replacement when the pressed session disappears", async () => {
    const first = subagent("first", "First worker", "completed");
    const second = subagent("second", "Second worker", "completed");
    const third = subagent("third", "Third worker", "completed");
    const board = createBoard(snapshot([first, second, third]), {
      refresh: async () => snapshot([first, third]),
    });
    const point = pointAt(board.render(86), "Second worker");
    board.handleMouse(mouse("press", point));
    board.handleInput("r");
    await vi.waitFor(() => expect(board.render(86).join("\n")).toContain("Refreshed"));
    board.handleInput("k");
    board.render(86);
    board.handleMouse(mouse("click", point));
    expect(board.render(86).find((line) => line.includes("First worker"))).toContain("›");
  });

  it("clicks visible tabs without changing selection on hover or press", () => {
    const board = createBoard(
      snapshot(
        [subagent("child", "Worker", "completed")],
        [userSession("user", "User handoff", "deferred", "2026-03-25T12:10:00.000Z")],
      ),
    );
    const tab = pointAt(board.render(86), "User sessions");
    expect(board.handleMouse(mouse("move", tab))).toBeUndefined();
    board.handleMouse(mouse("press", tab));
    expect(board.render(86).join("\n")).toContain("Worker");
    board.handleMouse(mouse("click", tab));
    expect(board.render(86).join("\n")).toContain("User handoff");
    clickAt(board, "Subagents");
    expect(board.render(86).join("\n")).toContain("Worker");
  });

  it("selects user sessions while their detail panel changes height", async () => {
    const first = userSession("first", "First handoff", "deferred", "2026-03-25T12:10:00.000Z");
    const second = userSession("second", "Second handoff", "deferred", "2026-03-25T12:11:00.000Z");
    const copy = vi.fn(async () => {});
    const board = createBoard(
      snapshot(
        [],
        [
          first,
          {
            ...second,
            receipt: { ...second.receipt, cwd: "/repo", backend: "tmux" },
          },
        ],
      ),
      { copy },
    );
    clickAt(board, "User sessions");
    const before = board.render(86);
    const point = pointAt(before, "Second handoff");
    board.handleMouse(mouse("press", point));
    const reflowed = board.render(86);
    expect(reflowed.length).toBe(before.length + 2);
    expect(reflowed.find((line) => line.includes("Second handoff"))).toContain("›");
    board.handleMouse(mouse("click", point));
    clickAt(board, "c copy resume");
    await vi.waitFor(() => expect(board.render(86).join("\n")).toContain("Resume command copied"));
    expect(copy).toHaveBeenCalledWith("pi --session-id 'second'");
    board.handleMouse(mouse("wheel", point, { wheelDelta: -1 }));
    expect(board.render(86).find((line) => line.includes("First handoff"))).toContain("›");
  });

  it("bounds wheel navigation to visible list rows and clamps both ends", () => {
    const board = createBoard(
      snapshot([
        subagent("first", "First worker", "completed"),
        subagent("second", "Second worker", "completed"),
      ]),
    );
    const lines = board.render(86);
    const point = pointAt(lines, "First worker");
    for (const outside of [
      { x: 1, y: point.y },
      { x: 84, y: point.y },
      { x: 5, y: point.y - 1 },
      { x: 5, y: point.y + 2 },
      pointAt(lines, "Details"),
      pointAt(lines, "<> tab"),
    ])
      expect(board.handleMouse(mouse("wheel", outside, { wheelDelta: 1 }))).toBeUndefined();
    expect(board.render(86).find((line) => line.includes("First worker"))).toContain("›");
    board.handleMouse(mouse("wheel", point, { wheelDelta: 8 }));
    expect(board.render(86).find((line) => line.includes("Second worker"))).toContain("›");
    board.handleMouse(mouse("wheel", point, { wheelDelta: 1 }));
    expect(board.render(86).find((line) => line.includes("Second worker"))).toContain("›");
    board.handleMouse(mouse("wheel", point, { wheelDelta: -1 }));
    board.handleMouse(mouse("wheel", point, { wheelDelta: -1 }));
    expect(board.render(86).find((line) => line.includes("First worker"))).toContain("›");
  });

  it("overwrites abandoned gestures on inert and non-primary presses", () => {
    const done = vi.fn();
    const board = createBoard(snapshot([]), { done });
    const close = pointAt(board.render(86), "esc close");
    for (const event of [
      mouse("press", { x: 0, y: 0 }),
      mouse("press", close, { button: "right" }),
    ]) {
      board.handleMouse(mouse("press", close));
      board.handleMouse(mouse("drag", { x: close.x + 1, y: close.y }));
      board.handleMouse(event);
      board.handleMouse(mouse("click", close));
    }
    expect(done).not.toHaveBeenCalled();
    clickAt(board, "esc close");
    expect(done).toHaveBeenCalledOnce();
  });

  it("ignores padding, separators, detail rows, directional hints and clipped controls", () => {
    const done = vi.fn();
    const copy = vi.fn(async () => {});
    const board = createBoard(snapshot([subagent("child", "Worker", "completed")]), { done, copy });
    const lines = board.render(86);
    const close = pointAt(lines, "esc close");
    const tabs = pointAt(lines, "Subagents");
    for (const point of [
      { x: 1, y: 6 },
      { x: 84, y: 6 },
      { x: 10, y: 5 },
      { x: close.x - 1, y: close.y },
      { x: close.x + 9, y: close.y },
      { x: tabs.x + 9, y: tabs.y },
      { x: tabs.x + 24, y: tabs.y },
      pointAt(lines, "Details"),
      pointAt(lines, "<> tab"),
      pointAt(lines, "↑↓ select"),
    ]) {
      expect(board.handleMouse(mouse("press", point))).toBeUndefined();
      expect(board.handleMouse(mouse("click", point))).toBeUndefined();
    }
    board.render(24);
    expect(board.handleMouse(mouse("press", { x: 13, y: tabs.y }))).toBeUndefined();
    expect(board.handleMouse(mouse("press", close))).toBeUndefined();
    board.handleMouse(mouse("click", close));
    expect(copy).not.toHaveBeenCalled();
    expect(done).not.toHaveBeenCalled();
  });

  it("copies observe and resume commands through their full action hints", async () => {
    const copy = vi.fn(async () => {});
    const board = createBoard(
      snapshot([subagent("child", "Worker", "completed", { tmuxWindowId: "@7" })]),
      { copy },
    );
    clickAt(board, "copy observe");
    const action = process.env.TMUX ? "switch-client" : "attach-session";
    await vi.waitFor(() =>
      expect(copy).toHaveBeenCalledWith(`tmux ${action} -t 'pi-123456781234:@7'`),
    );
    await vi.waitFor(() => expect(board.render(86).join("\n")).toContain("Observe command copied"));
    board.handleInput(".");
    clickAt(board, "copy resume");
    await vi.waitFor(() => expect(copy).toHaveBeenCalledWith("pi --session-id 'child'"));
  });

  it("confirms and cancels stop with separate clickable actions", async () => {
    const stop = vi.fn(async () => {});
    const done = vi.fn();
    const board = createBoard(snapshot([subagent("child", "Worker", "busy")]), { stop, done });
    clickAt(board, "x stop");
    expect(stop).not.toHaveBeenCalled();
    expect(board.render(86).join("\n")).toContain("x confirm");
    clickAt(board, "esc cancel");
    expect(board.render(86).join("\n")).toContain("x stop");
    expect(done).not.toHaveBeenCalled();
    clickAt(board, "x stop");
    clickAt(board, "x confirm");
    await vi.waitFor(() => expect(stop).toHaveBeenCalledExactlyOnceWith("child"));
  });

  it("aligns confirmation hits after a truncated wide-character title", async () => {
    const stop = vi.fn(async () => {});
    const board = createBoard(snapshot([subagent("child", "恢復".repeat(30), "busy")]), { stop });
    board.handleInput("x");
    const lines = board.render(50);
    expect(lines.every((line) => visibleWidth(line) <= 50)).toBe(true);
    const point = pointAt(lines, "x confirm");
    board.handleMouse(mouse("press", point));
    board.render(50);
    board.handleMouse(mouse("click", point));
    await vi.waitFor(() => expect(stop).toHaveBeenCalledExactlyOnceWith("child"));
  });

  it("ignores new controls while an action is pending", async () => {
    let finishCopy: () => void = () => {};
    const copied = new Promise<void>((resolve) => {
      finishCopy = resolve;
    });
    const copy = vi.fn(() => copied);
    const board = createBoard(
      snapshot([
        subagent("first", "First worker", "completed"),
        subagent("second", "Second worker", "completed"),
      ]),
      { copy },
    );
    const point = pointAt(board.render(86), "c copy resume");
    board.handleMouse(mouse("press", point));
    board.handleInput("c");
    const working = board.render(86);
    expect(working.join("\n")).toContain("Working…");
    expect(board.handleMouse(mouse("press", pointAt(working, "Second worker")))).toBeUndefined();
    board.handleMouse(mouse("wheel", pointAt(working, "Second worker"), { wheelDelta: 1 }));
    finishCopy();
    await vi.waitFor(() => expect(board.render(86).join("\n")).toContain("Resume command copied"));
    board.handleMouse(mouse("click", point));
    expect(copy).toHaveBeenCalledOnce();
    expect(board.render(86).find((line) => line.includes("First worker"))).toContain("›");
  });

  it("does not upgrade a pressed stop action into confirmation after state changes", () => {
    const stop = vi.fn(async () => {});
    const board = createBoard(snapshot([subagent("child", "Worker", "busy")]), { stop });
    const point = pointAt(board.render(86), "x stop");
    board.handleMouse(mouse("press", point));
    board.handleInput("x");
    board.render(86);
    board.handleMouse(mouse("click", point));
    expect(stop).not.toHaveBeenCalled();
    expect(board.render(86).join("\n")).toContain("x confirm");
  });

  it("does not reinterpret a pressed cancel as close after confirmation disappears", () => {
    const done = vi.fn();
    const board = createBoard(snapshot([subagent("child", "Worker", "busy")]), { done });
    board.handleInput("x");
    const point = pointAt(board.render(86), "esc cancel");
    board.handleMouse(mouse("press", point));
    board.handleInput("\u001b");
    board.render(86);
    board.handleMouse(mouse("click", point));
    expect(done).not.toHaveBeenCalled();
  });

  it("does not copy a different session after selection changes during a press", () => {
    const copy = vi.fn(async () => {});
    const board = createBoard(
      snapshot([
        subagent("first", "First worker", "completed"),
        subagent("second", "Second worker", "completed"),
      ]),
      { copy },
    );
    const point = pointAt(board.render(86), "c copy resume");
    board.handleMouse(mouse("press", point));
    board.handleInput("j");
    board.render(86);
    board.handleMouse(mouse("click", point));
    expect(copy).not.toHaveBeenCalled();
  });

  it("rejects a pressed action whose command changed in a refreshed snapshot", async () => {
    const worker = subagent("child", "Worker", "completed");
    const copy = vi.fn(async () => {});
    const board = createBoard(snapshot([worker]), {
      copy,
      refresh: async () => snapshot([{ ...worker, resumeCommand: "different command" }]),
    });
    const point = pointAt(board.render(86), "c copy resume");
    board.handleMouse(mouse("press", point));
    board.handleInput("r");
    await vi.waitFor(() => expect(board.render(86).join("\n")).toContain("Refreshed"));
    board.handleInput(".");
    board.render(86);
    board.handleMouse(mouse("click", point));
    expect(copy).not.toHaveBeenCalled();
  });

  it("does not turn a press on transient status into a newly revealed action", async () => {
    const scheduled: Array<() => void> = [];
    const copy = vi.fn(async () => {});
    const board = createBoard(snapshot([subagent("child", "Worker", "completed")]), {
      copy,
      schedule: (callback) => scheduled.push(callback),
    });
    const point = pointAt(board.render(86), "c copy resume");
    board.handleMouse(mouse("press", point));
    board.handleInput("c");
    await vi.waitFor(() => expect(board.render(86).join("\n")).toContain("Resume command copied"));
    expect(board.handleMouse(mouse("press", point))).toBeUndefined();
    scheduled.shift()?.();
    board.render(86);
    board.handleMouse(mouse("click", point));
    expect(copy).toHaveBeenCalledOnce();
  });
});

function pointAt(lines: string[], text: string): { x: number; y: number } {
  const y = lines.findIndex((line) => line.includes(text));
  const line = lines[y];
  if (line === undefined) throw new Error(`Board does not show ${text}`);
  return { x: visibleWidth(line.slice(0, line.indexOf(text))), y };
}

function mouse(
  type: TuiMouseEvent["type"],
  point: { x: number; y: number },
  overrides: Partial<TuiMouseEvent> = {},
): TuiMouseEvent {
  return {
    type,
    button: "left",
    ...point,
    screenX: point.x,
    screenY: point.y,
    width: 86,
    height: 40,
    shift: false,
    alt: false,
    ctrl: false,
    ...overrides,
  };
}

function clickAt(board: HandoffBoard, text: string): void {
  const point = pointAt(board.render(86), text);
  board.handleMouse(mouse("press", point));
  board.render(86);
  board.handleMouse(mouse("release", point));
  board.handleMouse(mouse("click", point));
}

describe("user sessions", () => {
  it("loads startup evidence from the receipt's child session file", async () => {
    const result = await loadHandoffBoardSnapshot(
      [toolReceipt("user", "2026-03-25T12:10:00.000Z", "left")],
      {
        listLiveSessions: async () => [],
        readSessionEntries: (path) => {
          expect(path).toBe("/tmp/user.jsonl");
          return [
            {
              type: "model_change",
              id: "model",
              parentId: null,
              timestamp: "2026-03-25T12:15:00.000Z",
              provider: "openai",
              modelId: "gpt-5.6-sol",
            } as never,
          ];
        },
      },
    );

    expect(result.userSessions[0]?.runEvidence).toEqual({
      transcriptAvailable: true,
      hasStarted: true,
    });
  });

  it("ignores receipts without a child session file and excludes subagents", () => {
    const missingFile = toolReceipt("missing", "2026-03-25T12:10:00.000Z", "left");
    delete (missingFile.message.details as { childSessionFile?: string }).childSessionFile;
    const entries: SessionEntry[] = [
      missingFile,
      toolReceipt("user", "2026-03-25T12:15:00.000Z", "left"),
      toolReceipt("worker", "2026-03-25T12:20:00.000Z", "subagent"),
    ];

    const result = collectUserSessions(entries);

    expect(result.map((entry) => entry.sessionId)).toEqual(["user"]);
    expect(result[0]?.receipt).toMatchObject({ title: "user title", launch: "left" });
  });
});

function createBoard(
  initial: HandoffBoardSnapshot,
  overrides?: {
    refresh?: () => Promise<HandoffBoardSnapshot>;
    stop?: (sessionId: string) => Promise<void>;
    copy?: (text: string) => Promise<void>;
    done?: (value: undefined) => void;
    schedule?: (callback: () => void, delayMs: number) => void;
    boardTheme?: typeof theme;
  },
): HandoffBoard {
  return new HandoffBoard(
    (overrides?.boardTheme ?? theme) as never,
    initial,
    {
      refresh: overrides?.refresh ?? (async () => initial),
      stop: overrides?.stop ?? (async () => {}),
      copy: overrides?.copy ?? (async () => {}),
    },
    overrides?.done ?? (() => {}),
    () => {},
    () => now,
    overrides?.schedule,
  );
}

function snapshot(
  subagents: readonly SubagentRosterEntry[],
  userSessions: HandoffBoardSnapshot["userSessions"] = [],
): HandoffBoardSnapshot {
  return {
    subagents,
    userSessions,
    liveSessionIds: new Set(),
    hasLiveSessionEvidence: true,
  };
}

function subagent(
  sessionId: string,
  title: string,
  state: SubagentRosterEntry["state"],
  overrides: Partial<SubagentRosterEntry> = {},
): SubagentRosterEntry {
  return {
    sessionId,
    sessionFile: `/tmp/${sessionId}.jsonl`,
    ownerSessionId,
    ownerTitle: "Board refinement",
    ownerIsCurrentSession: true,
    title,
    goal: "Do the work",
    model: "openai/gpt-5.6-sol:high",
    cwd: "/repo",
    resumeCommand: `pi --session-id '${sessionId}'`,
    launchedAt: "2026-03-25T12:07:00.000Z",
    depth: 1,
    state,
    onActiveBranch: true,
    managedLive: false,
    ...overrides,
  };
}

function userSession(
  sessionId: string,
  title: string,
  launch: "deferred" | "right",
  timestamp: string,
) {
  return {
    sessionId,
    timestamp,
    runEvidence: {
      transcriptAvailable: true,
      hasStarted: false,
    },
    receipt: {
      sessionId,
      title,
      launch,
      childSessionFile: `/tmp/${sessionId}.jsonl`,
      resumeCommand: `pi --session-id '${sessionId}'`,
      model: "openai/gpt-5.6-sol:high",
    },
  };
}

function toolReceipt(sessionId: string, timestamp: string, launch: "left" | "subagent") {
  return {
    type: "message" as const,
    id: `tool-${sessionId}`,
    parentId: null,
    timestamp,
    message: {
      role: "toolResult" as const,
      toolCallId: "call-1",
      toolName: "session_handoff",
      content: [{ type: "text" as const, text: "launched" }],
      isError: false,
      timestamp: Date.parse(timestamp),
      details: {
        sessionId,
        title: `${sessionId} title`,
        launch,
        childSessionFile: `/tmp/${sessionId}.jsonl`,
        resumeCommand: `pi --session-id '${sessionId}'`,
        backend: "tmux",
        model: "openai/gpt-5.6-sol:high",
      },
    },
  };
}
