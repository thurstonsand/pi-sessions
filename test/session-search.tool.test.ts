import path from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
  initializeSchema,
  insertSession,
  openIndexDatabase,
  setMetadata,
} from "../extensions/session-search/db.js";
import sessionSearchExtension from "../extensions/session-search.js";
import { createTestFilesystem } from "./test-helpers.js";

const testFs = createTestFilesystem("pi-sessions-search-tool-");

afterEach(() => {
  delete process.env.PI_SESSIONS_INDEX_DIR;
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
    const dir = testFs.createTempDir();
    process.env.PI_SESSIONS_INDEX_DIR = dir;
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
      undefined as never,
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
});

function registerSessionSearchTool() {
  let registeredTool: Parameters<ExtensionAPI["registerTool"]>[0] | undefined;

  sessionSearchExtension({
    registerTool(tool: Parameters<ExtensionAPI["registerTool"]>[0]) {
      registeredTool = tool;
    },
  } as unknown as ExtensionAPI);

  if (!registeredTool) {
    throw new Error("session_search tool was not registered");
  }

  return registeredTool;
}
