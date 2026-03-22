import { readFileSync } from "node:fs";
import path from "node:path";
import { type SessionInfo, SessionManager } from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildSearchSessionsQuery, openIndexDatabase } from "../extensions/session-search/db.js";
import { rebuildSessionIndex } from "../extensions/session-search/reindex.js";
import { createTestFilesystem } from "./test-helpers.js";

const testFs = createTestFilesystem("pi-sessions-reindex-");

afterEach(() => {
  vi.restoreAllMocks();
  testFs.cleanup();
});

describe("rebuildSessionIndex", () => {
  it("indexes sessions and text chunks from disk", async () => {
    const root = testFs.createTempDir();
    const sessionsDir = path.join(root, "sessions");
    const nestedDir = path.join(sessionsDir, "--repo--");
    const indexPath = path.join(root, "index.sqlite");

    const sessionPath = testFs.writeJsonlFile(nestedDir, "2026-03-22T00-00-00-000Z_demo.jsonl", [
      {
        type: "session",
        id: "demo-session",
        timestamp: "2026-03-22T00:00:00.000Z",
        cwd: "/repo/app",
      },
      {
        type: "session_info",
        id: "info-1",
        parentId: null,
        timestamp: "2026-03-22T00:00:01.000Z",
        name: "Demo session",
      },
      {
        type: "message",
        id: "user-1",
        parentId: "info-1",
        timestamp: "2026-03-22T00:00:02.000Z",
        message: {
          role: "user",
          content: [{ type: "text", text: "search for database indexing" }],
        },
      },
      {
        type: "message",
        id: "assistant-1",
        parentId: "user-1",
        timestamp: "2026-03-22T00:00:03.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "We should build a session index." }],
        },
      },
    ]);

    vi.spyOn(SessionManager, "listAll").mockResolvedValue([
      {
        path: sessionPath,
        id: "demo-session",
        cwd: "/repo/app",
        created: new Date("2026-03-22T00:00:00.000Z"),
        modified: new Date("2026-03-22T00:00:03.000Z"),
        messageCount: 2,
        firstMessage: "search for database indexing",
        allMessagesText: "search for database indexing\nWe should build a session index.",
      } satisfies SessionInfo,
    ]);

    const result = await rebuildSessionIndex({ indexPath });
    expect(result.sessionCount).toBe(1);
    expect(result.chunkCount).toBeGreaterThanOrEqual(3);

    const db = openIndexDatabase(indexPath, { create: false });
    const sessions = buildSearchSessionsQuery(db, { limit: 10 });
    const hits = buildSearchSessionsQuery(db, { query: "session index", limit: 10 });
    db.close();

    expect(readFileSync(indexPath).length).toBeGreaterThan(0);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.sessionId).toBe("demo-session");
    expect(hits).toHaveLength(1);
    expect(hits[0]?.snippet).toContain("session");
  });
});
