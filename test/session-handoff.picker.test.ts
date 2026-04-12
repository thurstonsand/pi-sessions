import path from "node:path";
import type { KeybindingsManager, Theme } from "@mariozechner/pi-coding-agent";
import type { TUI } from "@mariozechner/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionReferencePickerComponent } from "../extensions/session-handoff/picker.js";
import { listSessionPickerItems } from "../extensions/session-handoff/query.js";
import {
  SEARCH_SNIPPET_MATCH_END,
  SEARCH_SNIPPET_MATCH_START,
} from "../extensions/shared/search-snippet.js";
import {
  initializeSchema,
  insertSession,
  insertTextChunk,
  openIndexDatabase,
  rebuildSessionLineageRelations,
} from "../extensions/shared/session-index/index.js";
import { createTestFilesystem } from "./test-helpers.js";

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
        sessionId: "22222222-2222-4222-8222-222222222222",
        marker: "current",
        prefix: "",
      },
      {
        sessionId: "11111111-1111-4111-8111-111111111111",
        marker: "parent",
        prefix: "",
      },
      {
        sessionId: "33333333-3333-4333-8333-333333333333",
        marker: "child",
        prefix: "",
      },
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

    const rendered = picker.render(120).join("\n");
    expect(rendered).toContain("<accent><b>Selector</b></accent> session title");
    expect(rendered.match(/session title/g)).toHaveLength(1);
    expect(rendered).not.toContain(SEARCH_SNIPPET_MATCH_START);
    expect(rendered).not.toContain(SEARCH_SNIPPET_MATCH_END);
  });
});

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
    matches: vi.fn().mockReturnValue(false),
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
