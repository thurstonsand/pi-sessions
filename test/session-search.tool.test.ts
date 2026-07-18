import { writeFileSync } from "node:fs";
import path from "node:path";
import {
  type ExtensionAPI,
  initTheme,
  type ToolDefinition,
  ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { listSessionPickerItems } from "../extensions/session-handoff/query.ts";
import type { MessagingHandle } from "../extensions/session-messaging/install.ts";
import { installSearch } from "../extensions/session-search/install.ts";
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
  setMetadata,
} from "../extensions/shared/session-index/index.ts";
import { loadSettings } from "../extensions/shared/settings.ts";
import { createTestFilesystem } from "./test-helpers.ts";

const testFs = createTestFilesystem("pi-sessions-search-tool-");
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

beforeAll(() => {
  initTheme("dark");
});

afterEach(() => {
  if (originalAgentDir === undefined) {
    delete process.env.PI_CODING_AGENT_DIR;
  } else {
    process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  }
  testFs.cleanup();
});

describe("session_search tool", () => {
  it("returns a validation error for invalid date filters", async () => {
    const tool = registerSessionSearchTool();

    await expect(
      tool.execute(
        "tool-1",
        { time: { after: "not-a-date" } },
        undefined,
        undefined,
        undefined as never,
      ),
    ).rejects.toThrow("Invalid time.after value");
  });

  it("returns a validation error for non-positive limit", async () => {
    const tool = registerSessionSearchTool();

    await expect(
      tool.execute("tool-1", { limit: 0 }, undefined, undefined, undefined as never),
    ).rejects.toThrow("limit must be greater than 0");
  });

  it("returns structured model output and keeps visible output compact", async () => {
    const agentDir = testFs.createTempDir();
    const cwd = testFs.createTempDir();
    const dir = testFs.createTempDir();
    process.env.PI_CODING_AGENT_DIR = agentDir;
    writeFileSync(
      path.join(agentDir, "settings.json"),
      `${JSON.stringify({ sessions: { index: { dir } } }, null, 2)}\n`,
    );
    const dbPath = path.join(dir, "index.sqlite");

    const db = openIndexDatabase(dbPath, { create: true });
    initializeSchema(db);
    setMetadata(db, "indexed_at", "2026-03-22T00:00:00.000Z");
    insertSession(
      db,
      {
        sessionId: "session-1",
        sessionPath: "/tmp/session-1.jsonl",
        sessionName: "Visible title",
        cwd: "/repo/app",
        repoRoots: ["/repo"],
        startedAt: "2026-03-22T00:00:00.000Z",
        modifiedAt: "2026-03-22T00:10:00.000Z",
        messageCount: 1,
        entryCount: 1,
      },
      "full_reindex",
    );
    insertSession(
      db,
      {
        sessionId: "session-2",
        sessionPath: "/tmp/session-2.jsonl",
        sessionName: "Second title",
        cwd: "/repo/app",
        repoRoots: ["/repo"],
        startedAt: "2026-03-22T00:20:00.000Z",
        modifiedAt: "2026-03-22T00:30:00.000Z",
        messageCount: 1,
        entryCount: 1,
      },
      "full_reindex",
    );
    db.close();

    const tool = registerSessionSearchTool();
    const result = await tool.execute(
      "tool-1",
      { cwd: "/repo" },
      undefined,
      undefined,
      createToolContext(cwd),
    );
    const text = (result.content[0] as { text: string }).text;
    const modelOutput = JSON.parse(text) as { results: Array<{ sessionId: string; cwd: string }> };

    expect(modelOutput.results).toMatchObject([
      { sessionId: "session-2", cwd: "/repo/app" },
      { sessionId: "session-1", cwd: "/repo/app" },
    ]);

    const component = new ToolExecutionComponent(
      tool.name,
      "tool-1",
      { cwd: "/repo" },
      undefined,
      tool,
      createFakeTui(),
      "/repo",
    );
    component.updateResult(
      {
        content: result.content,
        details: result.details,
        isError: false,
      },
      false,
    );
    component.setExpanded(true);
    const rendered = stripAnsi(component.render(120).join("\n"));

    expect(rendered).toContain("1. Second title");
    expect(rendered).toContain("2. Visible title");
    expect(rendered).not.toContain("sessionPath");
    expect(rendered).not.toContain("modifiedAt");
    expect(rendered).not.toContain("\n\n\n");
    expect(rendered).not.toContain("score:");
  });

  it("strips internal snippet markers from tool text and brackets them in the rendered panel", async () => {
    const agentDir = testFs.createTempDir();
    const dir = testFs.createTempDir();
    process.env.PI_CODING_AGENT_DIR = agentDir;
    writeFileSync(
      path.join(agentDir, "settings.json"),
      `${JSON.stringify({ sessions: { index: { dir } } }, null, 2)}\n`,
    );
    const dbPath = path.join(dir, "index.sqlite");

    const db = openIndexDatabase(dbPath, { create: true });
    initializeSchema(db);
    setMetadata(db, "indexed_at", "2026-03-22T00:00:00.000Z");
    insertSession(
      db,
      {
        sessionId: "matched-session",
        sessionPath: "/tmp/matched.jsonl",
        sessionName: "Matched",
        cwd: "/repo/app",
        repoRoots: ["/repo"],
        startedAt: "2026-03-22T00:00:00.000Z",
        modifiedAt: "2026-03-22T00:10:00.000Z",
        messageCount: 2,
        entryCount: 2,
      },
      "full_reindex",
    );
    insertTextChunk(db, {
      sessionId: "matched-session",
      entryId: "entry-matched",
      entryType: "message",
      role: "assistant",
      ts: "2026-03-22T00:05:00.000Z",
      sourceKind: "assistant_text",
      text: "search hit",
    });
    db.close();

    const tool = registerSessionSearchTool();
    const result = await tool.execute(
      "tool-1",
      { cwd: "/repo", query: "search", limit: 1 },
      undefined,
      undefined,
      createToolContext("/repo"),
    );
    const text = (result.content[0] as { text: string }).text;
    const modelOutput = JSON.parse(text) as {
      results: Array<{ snippet: string; evidence: Array<{ kind: string; snippet?: string }> }>;
    };

    expect(modelOutput.results[0]?.snippet).toBe("search hit");
    expect(modelOutput.results[0]?.evidence).toContainEqual({
      kind: "text",
      sourceKind: "assistant_text",
      snippet: "search hit",
      score: expect.any(Number),
      entryId: "entry-matched",
    });
    expect(text).not.toContain(SEARCH_SNIPPET_MATCH_START);
    expect(text).not.toContain(SEARCH_SNIPPET_MATCH_END);

    const component = new ToolExecutionComponent(
      tool.name,
      "tool-1",
      { cwd: "/repo", query: "search", limit: 1 },
      undefined,
      tool,
      createFakeTui(),
      "/repo",
    );
    component.updateResult(
      {
        content: result.content,
        details: result.details,
        isError: false,
      },
      false,
    );
    component.setExpanded(true);
    const rendered = stripAnsi(component.render(120).join("\n"));

    expect(rendered).toContain("- [search] hit");
    expect(rendered).not.toContain(SEARCH_SNIPPET_MATCH_START);
    expect(rendered).not.toContain(SEARCH_SNIPPET_MATCH_END);
  });

  it("includes the current session and marks it as self", async () => {
    const agentDir = testFs.createTempDir();
    const dir = testFs.createTempDir();
    process.env.PI_CODING_AGENT_DIR = agentDir;
    writeFileSync(
      path.join(agentDir, "settings.json"),
      `${JSON.stringify({ sessions: { index: { dir } } }, null, 2)}\n`,
    );
    const dbPath = path.join(dir, "index.sqlite");

    const db = openIndexDatabase(dbPath, { create: true });
    initializeSchema(db);
    setMetadata(db, "indexed_at", "2026-03-22T00:00:00.000Z");
    insertSession(
      db,
      {
        sessionId: "current-session",
        sessionPath: "/tmp/current.jsonl",
        sessionName: "Current",
        cwd: "/repo/app",
        repoRoots: ["/repo"],
        startedAt: "2026-03-22T00:20:00.000Z",
        modifiedAt: "2026-03-22T00:30:00.000Z",
        messageCount: 2,
        entryCount: 2,
      },
      "full_reindex",
    );
    insertTextChunk(db, {
      sessionId: "current-session",
      entryId: "entry-current",
      entryType: "message",
      role: "assistant",
      ts: "2026-03-22T00:25:00.000Z",
      sourceKind: "assistant_text",
      text: "autocomplete parser",
    });
    insertSession(
      db,
      {
        sessionId: "older-session",
        sessionPath: "/tmp/older.jsonl",
        sessionName: "Older",
        cwd: "/repo/app",
        repoRoots: ["/repo"],
        startedAt: "2026-03-22T00:00:00.000Z",
        modifiedAt: "2026-03-22T00:10:00.000Z",
        messageCount: 2,
        entryCount: 2,
      },
      "full_reindex",
    );
    insertTextChunk(db, {
      sessionId: "older-session",
      entryId: "entry-older",
      entryType: "message",
      role: "assistant",
      ts: "2026-03-22T00:05:00.000Z",
      sourceKind: "assistant_text",
      text: "autocomplete parser",
    });
    rebuildSessionLineageRelations(db);
    db.close();

    const tool = registerSessionSearchTool();
    const result = await tool.execute(
      "tool-1",
      { cwd: "/repo", query: "autocomplete parser", limit: 1 },
      undefined,
      undefined,
      createToolContext("/repo", "current-session"),
    );
    const results =
      (result.details as { results: Array<{ sessionId: string; relation?: string }> }).results ??
      [];

    expect(results).toMatchObject([{ sessionId: "current-session", relation: "self" }]);
  });

  it("filters live searches through the active broker connection and returns relation metadata", async () => {
    const agentDir = testFs.createTempDir();
    const dir = testFs.createTempDir();
    process.env.PI_CODING_AGENT_DIR = agentDir;
    writeFileSync(
      path.join(agentDir, "settings.json"),
      `${JSON.stringify({ sessions: { index: { dir } } }, null, 2)}\n`,
    );
    const dbPath = path.join(dir, "index.sqlite");

    const db = openIndexDatabase(dbPath, { create: true });
    initializeSchema(db);
    setMetadata(db, "indexed_at", "2026-03-22T00:00:00.000Z");
    insertSession(
      db,
      {
        sessionId: "current-session",
        sessionPath: "/tmp/current.jsonl",
        sessionName: "Current",
        cwd: "/repo/app",
        repoRoots: ["/repo"],
        startedAt: "2026-03-22T00:00:00.000Z",
        modifiedAt: "2026-03-22T00:10:00.000Z",
        messageCount: 1,
        entryCount: 1,
      },
      "full_reindex",
    );
    insertSession(
      db,
      {
        sessionId: "live-child",
        sessionPath: "/tmp/live-child.jsonl",
        sessionName: "Live child",
        cwd: "/repo/app",
        repoRoots: ["/repo"],
        startedAt: "2026-03-22T00:20:00.000Z",
        modifiedAt: "2026-03-22T00:30:00.000Z",
        messageCount: 2,
        entryCount: 2,
        parentSessionPath: "/tmp/current.jsonl",
        parentSessionId: "current-session",
        sessionOrigin: "handoff",
      },
      "full_reindex",
    );
    insertSession(
      db,
      {
        sessionId: "offline-session",
        sessionPath: "/tmp/offline.jsonl",
        sessionName: "Offline",
        cwd: "/repo/app",
        repoRoots: ["/repo"],
        startedAt: "2026-03-22T00:40:00.000Z",
        modifiedAt: "2026-03-22T00:50:00.000Z",
        messageCount: 3,
        entryCount: 3,
      },
      "full_reindex",
    );
    rebuildSessionLineageRelations(db);
    db.close();

    const brokerConnection = {
      listSessionIds: async () => ["current-session", "live-child", "missing-live"],
    };
    const tool = registerSessionSearchTool({ messaging: brokerConnection });
    const result = await tool.execute(
      "tool-1",
      { cwd: "/repo", live: true },
      undefined,
      undefined,
      createToolContext("/repo", "current-session"),
    );
    const modelOutput = JSON.parse((result.content[0] as { text: string }).text) as {
      results: Array<{ sessionId: string; relation?: string }>;
    };

    expect(modelOutput.results).toMatchObject([
      { sessionId: "live-child", relation: "child" },
      { sessionId: "current-session", relation: "self" },
    ]);
    expect(modelOutput.results.map((result) => result.sessionId)).toEqual([
      "live-child",
      "current-session",
    ]);
  });

  it("fails live search clearly when session messaging is inactive", async () => {
    const agentDir = testFs.createTempDir();
    const dir = testFs.createTempDir();
    process.env.PI_CODING_AGENT_DIR = agentDir;
    writeFileSync(
      path.join(agentDir, "settings.json"),
      `${JSON.stringify({ sessions: { index: { dir } } }, null, 2)}\n`,
    );
    const dbPath = path.join(dir, "index.sqlite");

    const db = openIndexDatabase(dbPath, { create: true });
    initializeSchema(db);
    setMetadata(db, "indexed_at", "2026-03-22T00:00:00.000Z");
    db.close();

    const tool = registerSessionSearchTool({ messaging: undefined });
    await expect(
      tool.execute(
        "tool-1",
        { live: true },
        undefined,
        undefined,
        createToolContext("/repo", "current-session"),
      ),
    ).rejects.toThrow("Session messaging is not active");
  });

  it("keeps autocomplete search ordering in parity with the session_search tool", async () => {
    const agentDir = testFs.createTempDir();
    const dir = testFs.createTempDir();
    process.env.PI_CODING_AGENT_DIR = agentDir;
    writeFileSync(
      path.join(agentDir, "settings.json"),
      `${JSON.stringify({ sessions: { index: { dir } } }, null, 2)}\n`,
    );
    const dbPath = path.join(dir, "index.sqlite");

    const db = openIndexDatabase(dbPath, { create: true });
    initializeSchema(db);
    setMetadata(db, "indexed_at", "2026-03-22T00:00:00.000Z");
    insertSession(
      db,
      {
        sessionId: "older-session",
        sessionPath: "/tmp/older.jsonl",
        sessionName: "Older",
        cwd: "/repo/app",
        repoRoots: ["/repo"],
        startedAt: "2026-03-22T00:00:00.000Z",
        modifiedAt: "2026-03-22T00:10:00.000Z",
        messageCount: 2,
        entryCount: 2,
      },
      "full_reindex",
    );
    insertTextChunk(db, {
      sessionId: "older-session",
      entryId: "entry-older",
      entryType: "message",
      role: "assistant",
      ts: "2026-03-22T00:05:00.000Z",
      sourceKind: "assistant_text",
      text: "autocomplete parser",
    });
    insertSession(
      db,
      {
        sessionId: "newer-session",
        sessionPath: "/tmp/newer.jsonl",
        sessionName: "Newer",
        cwd: "/repo/app/sub",
        repoRoots: ["/repo"],
        startedAt: "2026-03-22T00:20:00.000Z",
        modifiedAt: "2026-03-22T00:30:00.000Z",
        messageCount: 2,
        entryCount: 2,
      },
      "full_reindex",
    );
    insertTextChunk(db, {
      sessionId: "newer-session",
      entryId: "entry-newer",
      entryType: "message",
      role: "assistant",
      ts: "2026-03-22T00:25:00.000Z",
      sourceKind: "assistant_text",
      text: "autocomplete parser",
    });
    db.close();

    const picker = listSessionPickerItems({
      indexPath: dbPath,
      currentCwd: "/repo",
      includeAll: false,
      mode: "search",
      query: "autocomplete parser",
    });
    const autocompleteIds = picker.items.flatMap((item) =>
      item.kind === "session" ? [item.sessionId] : [],
    );

    const tool = registerSessionSearchTool();
    const result = await tool.execute(
      "tool-1",
      { cwd: "/repo", query: "autocomplete parser" },
      undefined,
      undefined,
      createToolContext("/repo"),
    );
    const toolIds = (
      (result.details as { results: Array<{ sessionId: string }> }).results ?? []
    ).map((row) => row.sessionId);

    expect(autocompleteIds).toEqual(["newer-session", "older-session"]);
    expect(toolIds).toEqual(autocompleteIds);
  });
});

function registerSessionSearchTool(deps?: { messaging?: MessagingHandle | undefined }) {
  let registeredTool: ToolDefinition | undefined;

  const settings = loadSettings();
  installSearch(
    {
      registerTool(tool: ToolDefinition) {
        registeredTool = tool;
      },
    } as unknown as ExtensionAPI,
    { settings, index: { path: settings.index.path }, messaging: deps?.messaging },
  );

  if (!registeredTool) {
    throw new Error("session_search tool was not registered");
  }

  return registeredTool;
}

function createToolContext(cwd: string, sessionId = "another-session") {
  return {
    cwd,
    sessionManager: {
      getSessionId: () => sessionId,
    },
  } as never;
}

function createFakeTui(): TUI {
  return {
    requestRender() {},
  } as unknown as TUI;
}
