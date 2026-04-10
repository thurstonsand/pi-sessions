import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSessionHookController } from "../extensions/session-search/hooks.js";
import {
  getMetadata,
  initializeSchema,
  openIndexDatabase,
  searchSessions,
  setMetadata,
} from "../extensions/shared/session-index/index.js";
import { createTestFilesystem } from "./test-helpers.js";

const testFs = createTestFilesystem("pi-sessions-hooks-");

afterEach(() => {
  testFs.cleanup();
});

describe("session-search hooks", () => {
  it("stages tracked tool calls and finalizes tool results", () => {
    const controller = createSessionHookController({
      indexPath: path.join(testFs.createTempDir(), "missing.sqlite"),
    });

    controller.handleToolCall(
      {
        type: "tool_call",
        toolCallId: "call-read",
        toolName: "read",
        input: { path: "src/index.ts" },
      },
      "/tmp/session.jsonl",
      "/repo/app",
    );
    controller.handleToolCall(
      {
        type: "tool_call",
        toolCallId: "call-write",
        toolName: "write",
        input: { path: "src/out.ts" },
      },
      "/tmp/session.jsonl",
      "/repo/app",
    );
    controller.handleToolCall(
      {
        type: "tool_call",
        toolCallId: "call-bash",
        toolName: "bash",
        input: { command: "pwd" },
      },
      "/tmp/session.jsonl",
      "/repo/app",
    );
    controller.handleToolCall(
      {
        type: "tool_call",
        toolCallId: "call-empty",
        toolName: "read",
        input: { path: "   " },
      },
      "/tmp/session.jsonl",
      "/repo/app",
    );

    controller.handleToolResult({
      type: "tool_result",
      toolCallId: "call-read",
      toolName: "read",
      input: { path: "src/index.ts" },
      content: [{ type: "text", text: `${"R".repeat(520)}TAIL` }],
      details: undefined,
      isError: false,
    });
    controller.handleToolResult({
      type: "tool_result",
      toolCallId: "call-write",
      toolName: "write",
      input: { path: "src/out.ts" },
      content: [{ type: "text", text: `${"W".repeat(520)}TAIL` }],
      details: undefined,
      isError: false,
    });
    controller.handleToolResult({
      type: "tool_result",
      toolCallId: "call-bash",
      toolName: "bash",
      input: { command: "pwd" },
      content: [{ type: "text", text: "ignored" }],
      details: undefined,
      isError: false,
    });

    const state = controller.getState();
    expect(state.currentSessionFile).toBe("/tmp/session.jsonl");
    expect(state.pendingToolCalls).toHaveLength(0);
    expect(state.finalizedToolCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          toolCallId: "call-read",
          toolName: "read",
          path: "src/index.ts",
          resultText: `${"R".repeat(500)}…`,
        }),
        expect.objectContaining({
          toolCallId: "call-write",
          toolName: "write",
          path: "src/out.ts",
          resultText: `${"W".repeat(520)}TAIL`,
        }),
      ]),
    );
    expect(state.finalizedToolCalls).toHaveLength(2);
  });

  it("preserves the attached session file when later events omit it", async () => {
    const controller = createSessionHookController({
      indexPath: path.join(testFs.createTempDir(), "missing.sqlite"),
    });

    controller.handleToolCall(
      {
        type: "tool_call",
        toolCallId: "call-read",
        toolName: "read",
        input: { path: "src/index.ts" },
      },
      "/tmp/session.jsonl",
      "/repo/app",
    );

    expect(await controller.handleTurnEnd(undefined, "/repo/next")).toBe(false);

    const state = controller.getState();
    expect(state.currentSessionFile).toBe("/tmp/session.jsonl");
    expect(state.currentCwd).toBe("/repo/next");
    expect(state.pendingToolCalls).toHaveLength(0);
    expect(state.finalizedToolCalls).toHaveLength(0);
  });

  it("skips sync when the session file does not exist yet", async () => {
    const root = testFs.createTempDir();
    const indexPath = path.join(root, "index.sqlite");

    const db = openIndexDatabase(indexPath, { create: true });
    initializeSchema(db);
    setMetadata(db, "indexed_at", "2026-03-22T00:00:00.000Z");
    db.close();

    const controller = createSessionHookController({ indexPath });
    expect(await controller.handleSessionStart(path.join(root, "missing.jsonl"), "/repo/app")).toBe(
      false,
    );

    const indexedDb = openIndexDatabase(indexPath, { create: false });
    expect(getMetadata(indexedDb, "hook_last_event")).toBeUndefined();
    indexedDb.close();
  });

  it("flushes active sessions on start, turn_end, switch, and shutdown", async () => {
    const root = testFs.createTempDir();
    const indexPath = path.join(root, "index.sqlite");
    const repoRoot = testFs.ensureDir(path.join(root, "repo"));
    testFs.ensureDir(path.join(repoRoot, ".git"));
    const cwd = testFs.ensureDir(path.join(repoRoot, "app"));

    const db = openIndexDatabase(indexPath, { create: true });
    initializeSchema(db);
    setMetadata(db, "indexed_at", "2026-03-22T00:00:00.000Z");
    db.close();

    const sessionOnePath = testFs.writeJsonlFile(root, "session-one.jsonl", [
      {
        type: "session",
        id: "session-one",
        timestamp: "2026-03-22T00:00:00.000Z",
        cwd,
      },
      {
        type: "message",
        id: "user-1",
        parentId: null,
        timestamp: "2026-03-22T00:00:01.000Z",
        message: {
          role: "user",
          content: [{ type: "text", text: "touch the source file" }],
        },
      },
      {
        type: "message",
        id: "assistant-1",
        parentId: "user-1",
        timestamp: "2026-03-22T00:00:02.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Writing now." },
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
        type: "message",
        id: "tool-1",
        parentId: "assistant-1",
        timestamp: "2026-03-22T00:00:03.000Z",
        message: {
          role: "toolResult",
          toolCallId: "call-1",
          content: [{ type: "text", text: "updated file" }],
        },
      },
    ]);

    const sessionTwoPath = testFs.writeJsonlFile(root, "session-two.jsonl", [
      {
        type: "session",
        id: "session-two",
        timestamp: "2026-03-22T00:10:00.000Z",
        cwd,
      },
      {
        type: "message",
        id: "user-2",
        parentId: null,
        timestamp: "2026-03-22T00:10:01.000Z",
        message: {
          role: "user",
          content: [{ type: "text", text: "new session" }],
        },
      },
    ]);

    const controller = createSessionHookController({ indexPath });

    expect(await controller.handleSessionStart(sessionOnePath, cwd)).toBe(true);
    controller.handleToolCall(
      {
        type: "tool_call",
        toolCallId: "call-1",
        toolName: "write",
        input: { path: "src/index.ts" },
      },
      sessionOnePath,
      cwd,
    );
    controller.handleToolResult({
      type: "tool_result",
      toolCallId: "call-1",
      toolName: "write",
      input: { path: "src/index.ts" },
      content: [{ type: "text", text: "updated file" }],
      details: undefined,
      isError: false,
    });
    expect(await controller.handleTurnEnd(sessionOnePath, cwd)).toBe(true);
    expect(await controller.handleSessionSwitch(sessionOnePath, sessionTwoPath, cwd)).toBe(true);
    expect(await controller.handleSessionShutdown(sessionTwoPath, cwd)).toBe(true);

    const indexedDb = openIndexDatabase(indexPath, { create: false });
    const touchedHits = searchSessions(indexedDb, {
      repo: repoRoot,
      touched: ["src/index.ts"],
      limit: 10,
    });
    const recentSessions = searchSessions(indexedDb, { limit: 10 });
    const lastHookEvent = getMetadata(indexedDb, "hook_last_event");
    indexedDb.close();

    expect(touchedHits.map((result) => result.sessionId)).toContain("session-one");
    expect(recentSessions.map((result) => result.sessionId)).toEqual(
      expect.arrayContaining(["session-one", "session-two"]),
    );
    expect(lastHookEvent).toBe("session_shutdown");
    expect(controller.getState().lastFlushedSessionFile).toBe(sessionTwoPath);
  });

  it("records fork lineage and preserves it across later hook syncs", async () => {
    const root = testFs.createTempDir();
    const indexPath = path.join(root, "index.sqlite");
    const cwd = "/repo/app";

    const db = openIndexDatabase(indexPath, { create: true });
    initializeSchema(db);
    setMetadata(db, "indexed_at", "2026-03-22T00:00:00.000Z");
    db.close();

    const parentPath = testFs.writeJsonlFile(root, "parent.jsonl", [
      {
        type: "session",
        id: "parent-session",
        timestamp: "2026-03-22T00:00:00.000Z",
        cwd,
      },
    ]);
    const childPath = testFs.writeJsonlFile(root, "child.jsonl", [
      {
        type: "session",
        id: "child-session",
        timestamp: "2026-03-22T00:10:00.000Z",
        cwd,
        parentSession: parentPath,
      },
      {
        type: "message",
        id: "user-1",
        parentId: null,
        timestamp: "2026-03-22T00:10:01.000Z",
        message: {
          role: "user",
          content: [{ type: "text", text: "forked work" }],
        },
      },
    ]);

    const controller = createSessionHookController({ indexPath });

    expect(await controller.handleSessionStart(parentPath, cwd)).toBe(true);
    expect(await controller.handleSessionFork(parentPath, childPath, cwd)).toBe(true);
    expect(await controller.handleTurnEnd(childPath, cwd)).toBe(true);

    const indexedDb = openIndexDatabase(indexPath, { create: false });
    const childRow = indexedDb
      .prepare(
        `SELECT parent_session_path as parentSessionPath, parent_session_id as parentSessionId, session_origin as sessionOrigin FROM sessions WHERE session_id = ?`,
      )
      .get("child-session") as {
      parentSessionPath?: string;
      parentSessionId?: string;
      sessionOrigin?: string;
    };
    indexedDb.close();

    expect(childRow).toEqual({
      parentSessionPath: parentPath,
      parentSessionId: "parent-session",
      sessionOrigin: "fork",
    });
  });

  it("records handoff lineage when session_switch provides it", async () => {
    const root = testFs.createTempDir();
    const indexPath = path.join(root, "index.sqlite");
    const cwd = "/repo/app";

    const db = openIndexDatabase(indexPath, { create: true });
    initializeSchema(db);
    setMetadata(db, "indexed_at", "2026-03-22T00:00:00.000Z");
    db.close();

    const parentPath = testFs.writeJsonlFile(root, "parent.jsonl", [
      {
        type: "session",
        id: "parent-session",
        timestamp: "2026-03-22T00:00:00.000Z",
        cwd,
      },
    ]);
    const childPath = testFs.writeJsonlFile(root, "child.jsonl", [
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
          goal: "Finish the handoff",
          nextTask: "Implement autocomplete",
          initial_prompt: "Finish the handoff",
          initial_prompt_nonce: "handoff-nonce-2",
        },
      },
    ]);

    const controller = createSessionHookController({ indexPath });

    expect(await controller.handleSessionSwitch(parentPath, childPath, cwd, "handoff")).toBe(true);
    expect(await controller.handleTurnEnd(childPath, cwd)).toBe(true);

    const indexedDb = openIndexDatabase(indexPath, { create: false });
    const childRow = indexedDb
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
    indexedDb.close();

    expect(childRow).toEqual({
      parentSessionPath: parentPath,
      parentSessionId: "parent-session",
      sessionOrigin: "handoff",
      handoffGoal: "Finish the handoff",
      handoffNextTask: "Implement autocomplete",
    });
  });

  it("ingests session_tree and session_compact hook flushes", async () => {
    const root = testFs.createTempDir();
    const indexPath = path.join(root, "index.sqlite");
    const repoRoot = testFs.ensureDir(path.join(root, "repo"));
    testFs.ensureDir(path.join(repoRoot, ".git"));
    const cwd = testFs.ensureDir(path.join(repoRoot, "app"));

    const db = openIndexDatabase(indexPath, { create: true });
    initializeSchema(db);
    setMetadata(db, "indexed_at", "2026-03-22T00:00:00.000Z");
    db.close();

    const sessionPath = testFs.writeJsonlFile(root, "session-tree.jsonl", [
      {
        type: "session",
        id: "session-tree",
        timestamp: "2026-03-22T00:00:00.000Z",
        cwd,
      },
      {
        type: "branch_summary",
        id: "branch-1",
        parentId: null,
        timestamp: "2026-03-22T00:00:01.000Z",
        fromId: "root",
        summary: "Tree summary indexed by hook.",
        details: {
          modifiedFiles: ["docs/tree.md"],
        },
      },
      {
        type: "compaction",
        id: "compact-1",
        parentId: "branch-1",
        timestamp: "2026-03-22T00:00:02.000Z",
        firstKeptEntryId: "branch-1",
        tokensBefore: 1234,
        summary: "Compaction summary indexed by hook.",
        details: {
          readFiles: ["README.md"],
        },
      },
    ]);

    const controller = createSessionHookController({ indexPath });

    expect(await controller.handleSessionTree(sessionPath, cwd)).toBe(true);
    expect(await controller.handleSessionCompact(sessionPath, cwd)).toBe(true);

    const indexedDb = openIndexDatabase(indexPath, { create: false });
    const textHits = searchSessions(indexedDb, {
      query: "Compaction summary indexed",
      limit: 10,
    });
    const fileHits = searchSessions(indexedDb, {
      touched: ["docs/tree.md"],
      repo: repoRoot,
      limit: 10,
    });
    const lastHookEvent = getMetadata(indexedDb, "hook_last_event");
    indexedDb.close();

    expect(textHits.map((result) => result.sessionId)).toContain("session-tree");
    expect(fileHits.map((result) => result.sessionId)).toContain("session-tree");
    expect(lastHookEvent).toBe("session_compact");
  });
});
