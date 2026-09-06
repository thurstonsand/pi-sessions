import path from "node:path";
import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import {
  matchesKey,
  type Terminal,
  type TUI,
  TuiAltScreen,
  type TuiMouseEvent,
} from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionReferencePickerComponent } from "../extensions/session-handoff/picker.ts";
import { listSessionPickerItems } from "../extensions/session-handoff/query.ts";
import {
  SEARCH_SNIPPET_MATCH_END,
  SEARCH_SNIPPET_MATCH_START,
} from "../extensions/shared/search-snippet.ts";
import {
  initializeSchema,
  insertSession,
  insertTextChunk,
  openIndexDatabase,
  rebuildSessionLineageRelations,
} from "../extensions/shared/session-index/index.ts";
import { createTestFilesystem } from "./test-helpers.ts";

const testFs = createTestFilesystem("pi-sessions-handoff-picker-");

afterEach(() => {
  vi.useRealTimers();
  testFs.cleanup();
});

describe("session handoff picker", () => {
  it("shows an error row when the index is missing", () => {
    const result = listSessionPickerItems({
      indexPath: path.join(testFs.createTempDir(), "missing.sqlite"),
      currentCwd: "/repo/app",
      includeAll: false,
      mode: "browse",
    });

    expect(result.items).toEqual([
      {
        kind: "error",
        title: "Session index missing or incompatible",
        description: "Run /session-index to rebuild it.",
      },
    ]);
  });

  it("threads browse rows, simplifies markers, and caps visual depth", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-23T02:00:00.000Z"));
    const dbPath = createPickerDb();

    const result = listSessionPickerItems({
      currentSessionPath: "/tmp/current.jsonl",
      currentCwd: "/repo/app",
      includeAll: true,
      indexPath: dbPath,
      mode: "browse",
    });

    expect(result.items).toMatchObject([
      {
        kind: "session",
        sessionId: "11111111-1111-4111-8111-111111111111",
        title: "Parent session",
        marker: "parent",
        prefix: "",
      },
      {
        kind: "session",
        sessionId: "22222222-2222-4222-8222-222222222222",
        title: "Current session",
        marker: "current",
        prefix: "├─ ",
      },
      {
        kind: "session",
        sessionId: "33333333-3333-4333-8333-333333333333",
        title: "Child session",
        marker: "child",
        prefix: "  └─ ",
      },
      {
        kind: "session",
        sessionId: "44444444-4444-4444-8444-444444444444",
        marker: "44444444",
        prefix: "    └─ ",
      },
      {
        kind: "session",
        sessionId: "55555555-5555-4555-8555-555555555555",
        marker: "55555555",
        prefix: "    └─ ",
      },
      {
        kind: "session",
        sessionId: "66666666-6666-4666-8666-666666666666",
        title: "Sibling session",
        marker: "sibling",
        prefix: "└─ ",
      },
      {
        kind: "session",
        sessionId: "77777777-7777-4777-8777-777777777777",
        title: "Unrelated session",
        marker: "77777777",
        prefix: "",
      },
    ]);
  });

  it("closes when the configured shortcut is pressed while focused", () => {
    const done = vi.fn();
    const picker = new SessionReferencePickerComponent(
      createFakeTui(),
      createFakeTheme(),
      createFakeKeybindings(),
      done,
      {
        indexPath: path.join(testFs.createTempDir(), "missing.sqlite"),
        shortcut: "alt+o",
        getCurrentSessionPath: () => undefined,
        getCurrentCwd: () => "/repo/app",
      },
    );

    picker.handleInput("\u001b[111;3u");

    expect(done).toHaveBeenCalledWith({ kind: "cancel" });
  });

  it("shows a query syntax notice instead of throwing while search input is incomplete", () => {
    vi.useFakeTimers();
    const dbPath = createPickerDb();

    const result = listSessionPickerItems({
      currentSessionPath: "/tmp/current.jsonl",
      currentCwd: "/repo/app",
      includeAll: true,
      indexPath: dbPath,
      mode: "search",
      query: '"session search',
    });

    expect(result.items).toEqual([
      {
        kind: "error",
        title: "Invalid search query",
        description: "Unclosed quote at offset 0",
      },
    ]);

    const picker = new SessionReferencePickerComponent(
      createFakeTui(),
      createFakeTheme(),
      createFakeKeybindings(),
      vi.fn(),
      {
        indexPath: dbPath,
        shortcut: "alt+o",
        getCurrentSessionPath: () => "/tmp/current.jsonl",
        getCurrentCwd: () => "/repo/app",
      },
    );

    expect(() => picker.handleInput('"')).not.toThrow();
    vi.advanceTimersByTime(200);
    expect(stripAnsi(picker.render(120).join("\n"))).toContain("Invalid search query");
  });

  it("uses a flat ranked list in search mode", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-23T02:00:00.000Z"));
    const dbPath = createPickerDb();

    const result = listSessionPickerItems({
      currentSessionPath: "/tmp/current.jsonl",
      currentCwd: "/repo/app",
      includeAll: true,
      indexPath: dbPath,
      mode: "search",
      query: "selector",
    });

    const sessionItems = result.items.filter((item) => item.kind === "session");
    expect(sessionItems).toMatchObject([
      {
        sessionId: "66666666-6666-4666-8666-666666666666",
        marker: "sibling",
        prefix: "",
      },
      {
        sessionId: "44444444-4444-4444-8444-444444444444",
        marker: "44444444",
        prefix: "",
      },
      {
        sessionId: "33333333-3333-4333-8333-333333333333",
        marker: "child",
        prefix: "",
      },
      {
        sessionId: "22222222-2222-4222-8222-222222222222",
        marker: "current",
        prefix: "",
      },
      {
        sessionId: "11111111-1111-4111-8111-111111111111",
        marker: "parent",
        prefix: "",
      },
    ]);
  });

  it("aligns right-side metadata columns across rows", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-23T02:00:00.000Z"));
    const picker = new SessionReferencePickerComponent(
      createFakeTui(),
      createFakeTheme(),
      createFakeKeybindings(),
      vi.fn(),
      {
        indexPath: createPickerDb(),
        shortcut: "alt+o",
        getCurrentSessionPath: () => "/tmp/current.jsonl",
        getCurrentCwd: () => "/repo/app",
      },
    );

    const lines = picker.render(120);
    const parentLine = lines.find((line) => line.includes("Parent session"));
    const currentLine = lines.find((line) => line.includes("Current session"));
    expect(parentLine).toBeDefined();
    expect(currentLine).toBeDefined();
    expect(parentLine?.indexOf("parent")).toBe(currentLine?.indexOf("current"));
  });

  it("renders search snippets with accent-bold matched text", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-23T02:00:00.000Z"));
    const done = vi.fn();
    const picker = new SessionReferencePickerComponent(
      createFakeTui(),
      createHighlightTheme(),
      createFakeKeybindings(),
      done,
      {
        indexPath: createPickerDb(),
        shortcut: "alt+o",
        getCurrentSessionPath: () => "/tmp/current.jsonl",
        getCurrentCwd: () => "/repo/app",
      },
    );

    for (const char of "selector") {
      picker.handleInput(char);
    }
    vi.advanceTimersByTime(200);

    const rendered = picker.render(120).join("\n");
    expect(rendered).toContain("<accent><b>selector</b></accent>");
    expect(rendered.match(/›/g)).toHaveLength(1);
    expect(rendered).not.toContain(SEARCH_SNIPPET_MATCH_START);
    expect(rendered).not.toContain(SEARCH_SNIPPET_MATCH_END);
  });

  it("highlights a matching title directly and omits the duplicate snippet row", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-23T02:00:00.000Z"));
    const done = vi.fn();
    const picker = new SessionReferencePickerComponent(
      createFakeTui(),
      createHighlightTheme(),
      createFakeKeybindings(),
      done,
      {
        indexPath: createTitleMatchPickerDb(),
        shortcut: "alt+o",
        getCurrentSessionPath: () => undefined,
        getCurrentCwd: () => "/repo/app",
      },
    );

    for (const char of "selector") {
      picker.handleInput(char);
    }
    vi.advanceTimersByTime(200);

    const rendered = picker.render(120).join("\n");
    expect(rendered).toContain("<accent><b>Selector</b></accent> session title");
    expect(rendered.match(/session title/g)).toHaveLength(1);
    expect(rendered).not.toContain(SEARCH_SNIPPET_MATCH_START);
    expect(rendered).not.toContain(SEARCH_SNIPPET_MATCH_END);
  });
});

describe("session picker mouse", () => {
  function setup(tui: TUI = createFakeTui(), theme: Theme = createFakeTheme()) {
    vi.useFakeTimers();
    const done = vi.fn();
    const picker = new SessionReferencePickerComponent(tui, theme, createFakeKeybindings(), done, {
      indexPath: createPickerDb(),
      shortcut: "alt+o",
      getCurrentSessionPath: () => "/tmp/current.jsonl",
      getCurrentCwd: () => "/repo/app",
    });
    return { picker, done };
  }

  it("routes real fullscreen SGR gestures through overlay reflow and text selection", async () => {
    let sendInput: (data: string) => void = () => {
      throw new Error("Terminal not started");
    };
    const terminal: Terminal = {
      columns: 120,
      rows: 40,
      kittyProtocolActive: false,
      start(onInput) {
        sendInput = onInput;
      },
      stop() {},
      drainInput: async () => {},
      write: vi.fn(),
      moveBy() {},
      hideCursor() {},
      showCursor() {},
      clearLine() {},
      clearFromCursor() {},
      clearScreen() {},
      setTitle() {},
      setProgress() {},
    };
    const copySelection = vi.fn(async (_text: string) => true);
    const tui = new TuiAltScreen(terminal, false, undefined, { copySelection });
    const { picker, done } = setup(tui);
    tui.showOverlay(picker, { anchor: "bottom-center", width: 120 });
    tui.start();
    try {
      sendInput("selector");
      await vi.advanceTimersByTimeAsync(250);
      const before = picker.render(120).map(stripAnsi);
      const inputRow = terminal.rows - before.length + 4 + 1;
      sendInput(`\u001b[<0;4;${inputRow}M`);
      sendInput(`\u001b[<32;8;${inputRow}M`);
      sendInput(`\u001b[<0;8;${inputRow}m`);
      await vi.advanceTimersByTimeAsync(50);
      expect(copySelection).toHaveBeenCalledExactlyOnceWith("selec");
      expect(done).not.toHaveBeenCalled();
      const row = before.findIndex((line) => line.includes("Current session"));
      const screenRow = terminal.rows - before.length + row + 1;
      sendInput(`\u001b[<0;6;${screenRow}M`);
      await vi.advanceTimersByTimeAsync(50);
      const after = picker.render(120).map(stripAnsi);
      expect(after[row]).toContain("Parent session");
      expect(done).not.toHaveBeenCalled();
      sendInput(`\u001b[<0;6;${screenRow}m`);
      expect(done).toHaveBeenCalledExactlyOnceWith({
        kind: "insert-session-token",
        sessionId: "22222222-2222-4222-8222-222222222222",
      });
      if (process.env.PI_SESSIONS_MOUSE_SMOKE) {
        console.info(`SGR press at screen row ${screenRow}, before: ${before[row]}`);
        console.info(`After press, same row: ${after[row]}`);
        console.info("Release inserted Current session (22222222), not Parent session (11111111).");
        console.info("Filter drag reached fullscreen copySelection without inserting a session.");
      }
    } finally {
      tui.stop();
    }
  });

  it("commits the pressed session after selection scrolls different text under its row", () => {
    const { picker, done } = setup();
    picker.handleInput("selector");
    vi.advanceTimersByTime(200);
    const before = picker.render(120).map(stripAnsi);
    const row = before.findIndex((line) => line.includes("Current session"));
    expect(row).toBeGreaterThan(0);
    picker.handleMouse(mouse("press", 5, row));
    expect(done).not.toHaveBeenCalled();
    const after = picker.render(120).map(stripAnsi);
    expect(after[row]).toContain("Parent session");
    expect(after[row]).not.toBe(before[row]);
    picker.handleMouse(mouse("release", 5, row));
    picker.handleMouse(mouse("click", 5, row));
    expect(done).toHaveBeenCalledExactlyOnceWith({
      kind: "insert-session-token",
      sessionId: "22222222-2222-4222-8222-222222222222",
    });
  });

  it("preserves keyboard Enter's immediate flush of a pending search", () => {
    const { picker, done } = setup();
    picker.render(120);
    picker.handleInput("selector");
    picker.handleInput("\r");
    expect(done).toHaveBeenCalledExactlyOnceWith({
      kind: "insert-session-token",
      sessionId: "66666666-6666-4666-8666-666666666666",
    });
  });

  it("keeps the add hint's selected session when a pending search replaces the results", () => {
    const { picker, done } = setup();
    picker.handleInput("selector");
    picker.render(120);
    picker.handleMouse(mouse("press", 1, 2));
    vi.advanceTimersByTime(200);
    expect(picker.render(120).find((line) => line.includes("›"))).toContain("Sibling session");
    picker.handleMouse(mouse("click", 1, 2));
    expect(done).toHaveBeenCalledWith({
      kind: "insert-session-token",
      sessionId: "11111111-1111-4111-8111-111111111111",
    });
  });

  it("keeps session identity across a debounced result replacement", () => {
    const { picker, done } = setup();
    picker.handleInput("selector");
    const before = picker.render(120);
    const row = before.findIndex((line) => line.includes("Parent session"));
    picker.handleMouse(mouse("press", 5, row));
    vi.advanceTimersByTime(200);
    expect(picker.render(120)[row]).toContain("Sibling session");
    picker.handleMouse(mouse("click", 5, row));
    expect(done).toHaveBeenCalledWith({
      kind: "insert-session-token",
      sessionId: "11111111-1111-4111-8111-111111111111",
    });
  });

  it("does not lose keyboard selection when a pressed session disappeared before the next render", () => {
    const { picker, done } = setup();
    const before = picker.render(120);
    const row = before.findIndex((line) => line.includes("Great grandchild session"));
    picker.handleInput("selector");
    vi.advanceTimersByTime(200);
    picker.handleMouse(mouse("press", 5, row));
    const after = picker.render(120);
    expect(after.join("\n")).toContain("(1/5)");
    expect(after.find((line) => line.includes("›"))).toContain("Sibling session");
    picker.handleMouse(mouse("click", 5, row));
    expect(done).toHaveBeenCalledExactlyOnceWith({
      kind: "insert-session-token",
      sessionId: "55555555-5555-4555-8555-555555555555",
    });
  });

  it("forgets an abandoned press when the next press hits padding", () => {
    const { picker, done } = setup();
    const row = picker.render(120).findIndex((line) => line.includes("Parent session"));
    picker.handleMouse(mouse("press", 5, row));
    picker.handleMouse(mouse("drag", 8, row));
    picker.handleMouse(mouse("release", 8, row));
    expect(picker.handleMouse(mouse("press", 119, row))).toBeUndefined();
    expect(picker.handleMouse(mouse("click", 119, row))).toBeUndefined();
    expect(done).not.toHaveBeenCalled();
  });

  it("highlights a pressed hint through render, clears it on release, and still commits", () => {
    const theme = createFakeTheme();
    const background = vi.spyOn(theme, "bg");
    const { picker, done } = setup(createFakeTui(), theme);
    picker.render(120);
    picker.handleMouse(mouse("press", 1, 2));
    background.mockClear();
    picker.render(120);
    expect(background).toHaveBeenCalledWith("selectedBg", "enter add to prompt");
    expect(done).not.toHaveBeenCalled();
    expect(picker.handleMouse(mouse("release", 1, 2))).toMatchObject({ render: true });
    background.mockClear();
    picker.render(120);
    expect(background).not.toHaveBeenCalledWith("selectedBg", "enter add to prompt");
    picker.handleMouse(mouse("click", 1, 2));
    expect(done).toHaveBeenCalledExactlyOnceWith({
      kind: "insert-session-token",
      sessionId: "11111111-1111-4111-8111-111111111111",
    });
  });

  it("highlights scope labels without highlighting separators and clears drag feedback", () => {
    const theme = createFakeTheme();
    const background = vi.spyOn(theme, "bg");
    const { picker, done } = setup(createFakeTui(), theme);
    const x = (picker.render(120)[1] ?? "").indexOf("○ All");
    picker.handleMouse(mouse("press", x, 1));
    background.mockClear();
    picker.render(120);
    expect(background).toHaveBeenCalledWith("selectedBg", "○ All");
    expect(background).not.toHaveBeenCalledWith("selectedBg", " | ");
    picker.handleMouse(mouse("drag", x - 1, 1));
    background.mockClear();
    picker.render(120);
    expect(background).not.toHaveBeenCalledWith("selectedBg", "○ All");
    picker.handleMouse(mouse("click", x, 1));
    expect(picker.render(120)[1]).toContain("◉ Current Folder");
    expect(done).not.toHaveBeenCalled();
  });

  it("paints selected snippets only across their clickable text", () => {
    const theme = createFakeTheme();
    const background = vi.spyOn(theme, "bg");
    const { picker } = setup(createFakeTui(), theme);
    picker.handleInput("selector");
    vi.advanceTimersByTime(200);
    picker.render(120);
    expect(background).toHaveBeenCalledWith("selectedBg", "  selector");
  });

  it("selects snippet rows and ignores hover, non-primary buttons, borders and padding", () => {
    const { picker, done } = setup();
    picker.handleInput("selector");
    vi.advanceTimersByTime(200);
    const lines = picker.render(120);
    const row = lines.findIndex((line) => line.includes("Child session")) + 1;
    expect(lines[row]).toContain("selector");
    expect(picker.handleMouse(mouse("move", 5, row))).toBeUndefined();
    expect(picker.render(120).find((line) => line.includes("›"))).toContain("Sibling session");
    expect(picker.handleMouse({ ...mouse("press", 5, row), button: "right" })).toBeUndefined();
    const paddingX = stripAnsi(lines[row] ?? "")
      .slice(0, -1)
      .trimEnd().length;
    expect(picker.handleMouse(mouse("press", paddingX, row))).toBeUndefined();
    picker.handleMouse(mouse("press", 5, row));
    picker.render(120);
    picker.handleMouse(mouse("click", 5, row));
    expect(done).toHaveBeenCalledWith({
      kind: "insert-session-token",
      sessionId: "33333333-3333-4333-8333-333333333333",
    });
  });

  it("moves one item per wheel event only over the list and keeps navigation clamped", () => {
    const { picker } = setup();
    const row = picker.render(120).findIndex((line) => line.includes("Parent session"));
    picker.handleMouse({ ...mouse("wheel", 5, row), wheelDelta: 3 });
    expect(picker.render(120).find((line) => line.includes("›"))).toContain("Current session");
    expect(picker.handleMouse({ ...mouse("wheel", 5, 1), wheelDelta: 3 })).toBeUndefined();
    picker.handleInput("\u001b[5~");
    expect(picker.render(120).find((line) => line.includes("›"))).toContain("Parent session");
    picker.handleInput("\u001b[A");
    expect(picker.render(120).find((line) => line.includes("›"))).toContain("Parent session");
    picker.handleInput("\u001b[6~");
    expect(picker.render(120).find((line) => line.includes("›"))).toContain("Unrelated session");
    picker.handleInput("\u001b[B");
    expect(picker.render(120).find((line) => line.includes("›"))).toContain("Unrelated session");
  });

  it("places the filter cursor on click but leaves text presses and drags unhandled", () => {
    const { picker } = setup();
    picker.handleInput("selector");
    picker.render(120);
    expect(picker.handleMouse(mouse("press", 5, 4))).toBeUndefined();
    expect(picker.handleMouse(mouse("drag", 7, 4))).toBeUndefined();
    expect(picker.handleMouse(mouse("click", 5, 4))).toMatchObject({ handled: true, focus: true });
    picker.handleInput("X");
    expect(stripAnsi(picker.render(120)[4] ?? "")).toContain("seXlector");
  });

  it("runs advertised legend actions without making separators clickable", () => {
    const { picker, done } = setup();
    const line = picker.render(120)[2] ?? "";
    const scopeX = line.indexOf("tab scope");
    expect(picker.handleMouse(mouse("press", line.indexOf("·"), 2))).toBeUndefined();
    picker.handleMouse(mouse("click", line.indexOf("·"), 2));
    expect(done).not.toHaveBeenCalled();
    picker.handleMouse(mouse("press", scopeX, 2));
    picker.handleMouse(mouse("click", scopeX, 2));
    expect(picker.render(120)[1]).toContain("◉ All");
    picker.handleMouse(mouse("press", line.indexOf("enter"), 2));
    picker.handleMouse(mouse("click", line.indexOf("enter"), 2));
    expect(done).toHaveBeenCalledWith({
      kind: "insert-session-token",
      sessionId: "11111111-1111-4111-8111-111111111111",
    });
  });

  it("clicks either scope label and cancels from the legend", () => {
    const { picker, done } = setup();
    let header = picker.render(120)[1] ?? "";
    picker.handleMouse(mouse("press", header.indexOf("○ All"), 1));
    picker.handleMouse(mouse("click", header.indexOf("○ All"), 1));
    header = picker.render(120)[1] ?? "";
    expect(header).toContain("◉ All");
    picker.handleMouse(mouse("press", header.indexOf("Current Folder"), 1));
    picker.handleMouse(mouse("click", header.indexOf("Current Folder"), 1));
    const lines = picker.render(120);
    expect(lines[1]).toContain("◉ Current Folder");
    const x = (lines[2] ?? "").indexOf("esc cancel");
    picker.handleMouse(mouse("press", x, 2));
    picker.handleMouse(mouse("click", x, 2));
    expect(done).toHaveBeenCalledWith({ kind: "cancel" });
  });
});

function mouse(type: TuiMouseEvent["type"], x: number, y: number): TuiMouseEvent {
  return {
    type,
    button: "left",
    x,
    y,
    screenX: x,
    screenY: y,
    width: 120,
    height: 18,
    shift: false,
    alt: false,
    ctrl: false,
  };
}

function createFakeTui(): TUI {
  return {
    requestRender: vi.fn(),
    terminal: { cols: 120, rows: 40 },
  } as unknown as TUI;
}

function createFakeTheme(): Theme {
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

function createHighlightTheme(): Theme {
  return {
    fg(color: string, text: string) {
      return color === "accent" ? `<accent>${text}</accent>` : text;
    },
    bg(_color: string, text: string) {
      return text;
    },
    bold(text: string) {
      return `<b>${text}</b>`;
    },
  } as unknown as Theme;
}

function createFakeKeybindings(): KeybindingsManager {
  return {
    matches: vi.fn((data: string, action: string) => {
      switch (action) {
        case "tui.select.up":
          return matchesKey(data, "up");
        case "tui.select.down":
          return matchesKey(data, "down");
        case "tui.select.pageUp":
          return matchesKey(data, "pageUp");
        case "tui.select.pageDown":
          return matchesKey(data, "pageDown");
        case "tui.select.confirm":
          return matchesKey(data, "enter");
        case "tui.select.cancel":
          return matchesKey(data, "escape");
        case "tui.input.tab":
          return matchesKey(data, "tab");
        default:
          return false;
      }
    }),
  } as unknown as KeybindingsManager;
}

function createTitleMatchPickerDb(): string {
  const dir = testFs.createTempDir();
  const dbPath = path.join(dir, "index.sqlite");
  const db = openIndexDatabase(dbPath, { create: true });
  initializeSchema(db);

  insertSession(
    db,
    {
      sessionId: "88888888-8888-4888-8888-888888888888",
      sessionPath: "/tmp/title-match.jsonl",
      sessionName: "Selector session title",
      cwd: "/repo/app",
      repoRoots: ["/repo"],
      startedAt: "2026-03-23T00:00:00.000Z",
      modifiedAt: "2026-03-23T00:10:00.000Z",
      messageCount: 12,
      entryCount: 12,
    },
    "full_reindex",
  );
  insertTextChunk(db, {
    sessionId: "88888888-8888-4888-8888-888888888888",
    entryId: "title-match-name",
    entryType: "session_name",
    role: "system",
    ts: "2026-03-23T00:00:00.000Z",
    sourceKind: "session_name",
    text: "Selector session title",
  });

  rebuildSessionLineageRelations(db);
  db.close();
  return dbPath;
}

function createPickerDb(): string {
  const dir = testFs.createTempDir();
  const dbPath = path.join(dir, "index.sqlite");
  const db = openIndexDatabase(dbPath, { create: true });
  initializeSchema(db);

  insertSession(
    db,
    {
      sessionId: "11111111-1111-4111-8111-111111111111",
      sessionPath: "/tmp/parent.jsonl",
      sessionName: "Parent session",
      cwd: "/repo/app",
      repoRoots: ["/repo"],
      startedAt: "2026-03-23T00:00:00.000Z",
      modifiedAt: "2026-03-23T00:10:00.000Z",
      messageCount: 10,
      entryCount: 10,
    },
    "full_reindex",
  );
  insertTextChunk(db, {
    sessionId: "11111111-1111-4111-8111-111111111111",
    entryId: "parent-search",
    entryType: "message",
    role: "assistant",
    ts: "2026-03-23T00:10:00.000Z",
    sourceKind: "assistant_text",
    text: "selector",
  });

  insertSession(
    db,
    {
      sessionId: "22222222-2222-4222-8222-222222222222",
      sessionPath: "/tmp/current.jsonl",
      sessionName: "Current session",
      cwd: "/repo/app",
      repoRoots: ["/repo"],
      startedAt: "2026-03-23T00:20:00.000Z",
      modifiedAt: "2026-03-23T00:30:00.000Z",
      messageCount: 20,
      entryCount: 20,
      parentSessionPath: "/tmp/parent.jsonl",
      parentSessionId: "11111111-1111-4111-8111-111111111111",
      sessionOrigin: "handoff",
    },
    "full_reindex",
  );
  insertTextChunk(db, {
    sessionId: "22222222-2222-4222-8222-222222222222",
    entryId: "current-search",
    entryType: "message",
    role: "assistant",
    ts: "2026-03-23T00:30:00.000Z",
    sourceKind: "assistant_text",
    text: "selector",
  });

  insertSession(
    db,
    {
      sessionId: "33333333-3333-4333-8333-333333333333",
      sessionPath: "/tmp/child.jsonl",
      sessionName: "Child session",
      cwd: "/repo/app",
      repoRoots: ["/repo"],
      startedAt: "2026-03-23T00:40:00.000Z",
      modifiedAt: "2026-03-23T00:50:00.000Z",
      messageCount: 30,
      entryCount: 30,
      parentSessionPath: "/tmp/current.jsonl",
      parentSessionId: "22222222-2222-4222-8222-222222222222",
      sessionOrigin: "handoff",
    },
    "full_reindex",
  );
  insertTextChunk(db, {
    sessionId: "33333333-3333-4333-8333-333333333333",
    entryId: "child-search",
    entryType: "message",
    role: "assistant",
    ts: "2026-03-23T00:50:00.000Z",
    sourceKind: "assistant_text",
    text: "selector",
  });

  insertSession(
    db,
    {
      sessionId: "44444444-4444-4444-8444-444444444444",
      sessionPath: "/tmp/grandchild.jsonl",
      sessionName: "Grandchild session",
      cwd: "/repo/app",
      repoRoots: ["/repo"],
      startedAt: "2026-03-23T01:00:00.000Z",
      modifiedAt: "2026-03-23T01:10:00.000Z",
      messageCount: 40,
      entryCount: 40,
      parentSessionPath: "/tmp/child.jsonl",
      parentSessionId: "33333333-3333-4333-8333-333333333333",
      sessionOrigin: "handoff",
    },
    "full_reindex",
  );
  insertTextChunk(db, {
    sessionId: "44444444-4444-4444-8444-444444444444",
    entryId: "grandchild-search",
    entryType: "message",
    role: "assistant",
    ts: "2026-03-23T01:10:00.000Z",
    sourceKind: "assistant_text",
    text: "selector",
  });

  insertSession(
    db,
    {
      sessionId: "55555555-5555-4555-8555-555555555555",
      sessionPath: "/tmp/great-grandchild.jsonl",
      sessionName: "Great grandchild session",
      cwd: "/repo/app",
      repoRoots: ["/repo"],
      startedAt: "2026-03-23T01:20:00.000Z",
      modifiedAt: "2026-03-23T01:30:00.000Z",
      messageCount: 50,
      entryCount: 50,
      parentSessionPath: "/tmp/grandchild.jsonl",
      parentSessionId: "44444444-4444-4444-8444-444444444444",
      sessionOrigin: "handoff",
    },
    "full_reindex",
  );

  insertSession(
    db,
    {
      sessionId: "66666666-6666-4666-8666-666666666666",
      sessionPath: "/tmp/sibling.jsonl",
      sessionName: "Sibling session",
      cwd: "/repo/app",
      repoRoots: ["/repo"],
      startedAt: "2026-03-23T01:40:00.000Z",
      modifiedAt: "2026-03-23T01:50:00.000Z",
      messageCount: 60,
      entryCount: 60,
      parentSessionPath: "/tmp/parent.jsonl",
      parentSessionId: "11111111-1111-4111-8111-111111111111",
      sessionOrigin: "handoff",
    },
    "full_reindex",
  );
  insertTextChunk(db, {
    sessionId: "66666666-6666-4666-8666-666666666666",
    entryId: "sibling-search",
    entryType: "message",
    role: "assistant",
    ts: "2026-03-23T01:50:00.000Z",
    sourceKind: "assistant_text",
    text: "selector",
  });

  insertSession(
    db,
    {
      sessionId: "77777777-7777-4777-8777-777777777777",
      sessionPath: "/tmp/unrelated.jsonl",
      sessionName: "Unrelated session",
      cwd: "/repo/app",
      repoRoots: ["/repo"],
      startedAt: "2026-03-23T01:55:00.000Z",
      modifiedAt: "2026-03-23T01:56:00.000Z",
      messageCount: 70,
      entryCount: 70,
    },
    "full_reindex",
  );

  rebuildSessionLineageRelations(db);
  db.close();
  return dbPath;
}
