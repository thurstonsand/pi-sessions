import { writeFileSync } from "node:fs";
import path from "node:path";
import type { ExtensionAPI, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { listSessionPickerItems } from "../extensions/session-handoff/query.js";
import sessionSearchExtension from "../extensions/session-search.js";
import {
  initializeSchema,
  insertSession,
  insertTextChunk,
  openIndexDatabase,
  setMetadata,
} from "../extensions/shared/session-index/index.js";
import { createTestFilesystem } from "./test-helpers.js";

const testFs = createTestFilesystem("pi-sessions-search-tool-");
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

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

    const result = await tool.execute(
      "tool-1",
      { time: { after: "not-a-date" } },
      undefined,
      undefined,
      undefined as never,
    );

    expect(result.details).toMatchObject({ error: true });
    expect(result.content[0]?.type).toBe("text");
    expect((result.content[0] as { text: string }).text).toContain("Invalid time.after value");
  });

  it("returns a validation error for non-positive limit", async () => {
    const tool = registerSessionSearchTool();

    const result = await tool.execute(
      "tool-1",
      { limit: 0 },
      undefined,
      undefined,
      undefined as never,
    );

    expect(result.details).toMatchObject({ error: true });
    expect((result.content[0] as { text: string }).text).toContain("limit must be greater than 0");
  });

  it("formats visible output grouped by cwd without path or updated fields", async () => {
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

    expect(text).toContain("cwd: /repo/app\nSecond title: session-2");
    expect(text).toContain("Visible title: session-1");
    expect(text.match(/cwd: \/repo\/app/g)).toHaveLength(1);
    expect(text).not.toContain("path:");
    expect(text).not.toContain("updated:");
    expect(text).not.toContain("\n\n\n");
    expect(text).not.toContain("score:");
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

function registerSessionSearchTool() {
  let registeredTool: ToolDefinition | undefined;

  sessionSearchExtension({
    registerTool(tool: ToolDefinition) {
      registeredTool = tool;
    },
  } as unknown as ExtensionAPI);

  if (!registeredTool) {
    throw new Error("session_search tool was not registered");
  }

  return registeredTool;
}

function createToolContext(cwd: string) {
  return { cwd } as never;
}
