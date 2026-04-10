import { readFileSync } from "node:fs";
import path from "node:path";
import { type SessionInfo, SessionManager } from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { rebuildSessionIndex } from "../extensions/session-search/reindex.js";
import { openIndexDatabase, searchSessions } from "../extensions/shared/session-index/index.js";
import { createTestFilesystem } from "./test-helpers.js";

const testFs = createTestFilesystem("pi-sessions-reindex-");

afterEach(() => {
  vi.restoreAllMocks();
  testFs.cleanup();
});

describe("rebuildSessionIndex", () => {
  it("indexes sessions, repo roots, and file touches from disk", async () => {
    const root = testFs.createTempDir();
    const sessionsDir = path.join(root, "sessions");
    const nestedDir = path.join(sessionsDir, "--repo--");
    const indexPath = path.join(root, "index.sqlite");
    const repoRoot = testFs.ensureDir(path.join(root, "repo"));
    testFs.ensureDir(path.join(repoRoot, ".git"));
    const cwd = testFs.ensureDir(path.join(repoRoot, "app"));

    const sessionPath = testFs.writeJsonlFile(nestedDir, "2026-03-22T00-00-00-000Z_demo.jsonl", [
      {
        type: "session",
        id: "demo-session",
        timestamp: "2026-03-22T00:00:00.000Z",
        cwd,
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
          content: [
            { type: "text", text: "We should build a session index." },
            {
              type: "toolCall",
              id: "call-1",
              name: "write",
              arguments: { path: "src/index.ts" },
            },
          ],
        },
      },
      {
        type: "branch_summary",
        id: "branch-1",
        parentId: "assistant-1",
        timestamp: "2026-03-22T00:00:04.000Z",
        summary: "Indexed the repo work.",
        details: {
          modifiedFiles: ["docs/plan.md"],
        },
      },
    ]);

    vi.spyOn(SessionManager, "listAll").mockResolvedValue([
      {
        path: sessionPath,
        id: "demo-session",
        cwd,
        created: new Date("2026-03-22T00:00:00.000Z"),
        modified: new Date("2026-03-22T00:00:04.000Z"),
        messageCount: 2,
        firstMessage: "search for database indexing",
        allMessagesText: "search for database indexing\nWe should build a session index.",
      } satisfies SessionInfo,
    ]);

    const result = await rebuildSessionIndex({ indexPath });
    expect(result.sessionCount).toBe(1);
    expect(result.chunkCount).toBeGreaterThanOrEqual(3);

    const db = openIndexDatabase(indexPath, { create: false });
    const sessions = searchSessions(db, { limit: 10 });
    const hits = searchSessions(db, { query: "session index", limit: 10 });
    const fileHits = searchSessions(db, {
      touched: ["src/index.ts"],
      repo: repoRoot,
      limit: 10,
    });
    db.close();

    expect(readFileSync(indexPath).length).toBeGreaterThan(0);
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.sessionId).toBe("demo-session");
    expect(sessions[0]?.repoRoots).toEqual([repoRoot]);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.snippet).toContain("session");
    expect(fileHits).toHaveLength(1);
    expect(fileHits[0]?.matchedFiles).toEqual(["app/src/index.ts"]);
  });

  it("persists unknown child lineage during full reindex", async () => {
    const root = testFs.createTempDir();
    const sessionsDir = path.join(root, "sessions");
    const nestedDir = path.join(sessionsDir, "--repo--");
    const indexPath = path.join(root, "index.sqlite");
    const cwd = "/repo/app";

    const parentPath = testFs.writeJsonlFile(nestedDir, "2026-03-22T00-00-00-000Z_parent.jsonl", [
      {
        type: "session",
        id: "parent-session",
        timestamp: "2026-03-22T00:00:00.000Z",
        cwd,
      },
    ]);
    const childPath = testFs.writeJsonlFile(nestedDir, "2026-03-22T00-10-00-000Z_child.jsonl", [
      {
        type: "session",
        id: "child-session",
        timestamp: "2026-03-22T00:10:00.000Z",
        cwd,
        parentSession: parentPath,
      },
      {
        type: "custom",
        id: "custom-1",
        parentId: null,
        timestamp: "2026-03-22T00:10:01.000Z",
        customType: "pi-sessions.handoff",
        data: {
          origin: "handoff",
          goal: "Finish the split",
          nextTask: "Implement autocomplete",
          initial_prompt: "Finish the split",
          initial_prompt_nonce: "handoff-nonce-3",
        },
      },
    ]);

    vi.spyOn(SessionManager, "listAll").mockResolvedValue([
      {
        path: parentPath,
        id: "parent-session",
        cwd,
        created: new Date("2026-03-22T00:00:00.000Z"),
        modified: new Date("2026-03-22T00:00:00.000Z"),
        messageCount: 0,
        firstMessage: "",
        allMessagesText: "",
      } satisfies SessionInfo,
      {
        path: childPath,
        id: "child-session",
        cwd,
        created: new Date("2026-03-22T00:10:00.000Z"),
        modified: new Date("2026-03-22T00:10:00.000Z"),
        messageCount: 0,
        firstMessage: "",
        allMessagesText: "",
      } satisfies SessionInfo,
    ]);

    await rebuildSessionIndex({ indexPath });

    const db = openIndexDatabase(indexPath, { create: false });
    const childRow = db
      .prepare(
        `SELECT parent_session_path as parentSessionPath, parent_session_id as parentSessionId, session_origin as sessionOrigin, handoff_goal as handoffGoal, handoff_next_task as handoffNextTask FROM sessions WHERE session_id = ?`,
      )
      .get("child-session") as {
      parentSessionPath?: string;
      parentSessionId?: string;
      sessionOrigin?: string;
      handoffGoal?: string;
      handoffNextTask?: string;
    };
    db.close();

    expect(childRow).toEqual({
      parentSessionPath: parentPath,
      parentSessionId: "parent-session",
      sessionOrigin: "handoff",
      handoffGoal: "Finish the split",
      handoffNextTask: "Implement autocomplete",
    });
  });
});
