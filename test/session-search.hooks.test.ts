import { appendFileSync } from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it } from "vitest";
import { createSessionHookController } from "../extensions/session-search/hooks.ts";
import {
  getMetadata,
  initializeSchema,
  openIndexDatabase,
  searchSessions,
  setMetadata,
} from "../extensions/shared/session-index/index.ts";
import { createTestFilesystem } from "./test-helpers.ts";

const testFs = createTestFilesystem("pi-sessions-hooks-");

afterEach(() => {
  testFs.cleanup();
});

describe("session-search hooks", () => {
  it("preserves the attached session file when later events omit it", async () => {
    const root = testFs.createTempDir();
    const indexPath = path.join(root, "index.sqlite");
    const db = openIndexDatabase(indexPath);
    initializeSchema(db);
    const session = testFs.writeJsonlFile(root, "attached.jsonl", [
      {
        type: "session",
        id: "attached",
        timestamp: "2026-03-22T00:00:00.000Z",
        cwd: root,
      },
    ]);
    const controller = createSessionHookController({ indexPath });
    expect(await controller.handleSessionStart(session)).toBe(true);
    expect(await controller.handleTurnEnd(undefined)).toBe(true);
    expect(getMetadata(db, "hook_last_event")).toBe("turn_end");
    expect(await controller.handleSessionShutdown(undefined)).toBe(true);
    expect(await controller.handleTurnEnd(undefined)).toBe(false);
    db.close();
  });

  it("skips sync when the session file does not exist yet", async () => {
    const root = testFs.createTempDir();
    const indexPath = path.join(root, "index.sqlite");

    const db = openIndexDatabase(indexPath, { create: true });
    initializeSchema(db);
    setMetadata(db, "indexed_at", "2026-03-22T00:00:00.000Z");
    db.close();

    const controller = createSessionHookController({ indexPath });
    expect(await controller.handleSessionStart(path.join(root, "missing.jsonl"))).toBe(false);

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

    expect(await controller.handleSessionStart(sessionOnePath)).toBe(true);
    expect(await controller.handleTurnEnd(sessionOnePath)).toBe(true);
    expect(await controller.handleSessionSwitch(sessionOnePath, sessionTwoPath)).toBe(true);
    expect(await controller.handleSessionShutdown(sessionTwoPath)).toBe(true);

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

    expect(await controller.handleSessionStart(parentPath)).toBe(true);
    expect(await controller.handleSessionFork(parentPath, childPath)).toBe(true);
    expect(await controller.handleTurnEnd(childPath)).toBe(true);

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
          title: "Implement autocomplete",
          initial_prompt: "Finish the handoff",
          launch: "deferred",
        },
      },
    ]);

    const controller = createSessionHookController({ indexPath });

    expect(await controller.handleSessionSwitch(parentPath, childPath, "handoff")).toBe(true);
    expect(await controller.handleTurnEnd(childPath)).toBe(true);

    const indexedDb = openIndexDatabase(indexPath, { create: false });
    const childRow = indexedDb
      .prepare(
        `SELECT parent_session_path as parentSessionPath, parent_session_id as parentSessionId, session_origin as sessionOrigin, handoff_goal as handoffGoal FROM sessions WHERE session_id = ?`,
      )
      .get("child-session") as {
      parentSessionPath?: string;
      parentSessionId?: string;
      sessionOrigin?: string;
      handoffGoal?: string;
    };
    indexedDb.close();

    expect(childRow).toEqual({
      parentSessionPath: parentPath,
      parentSessionId: "parent-session",
      sessionOrigin: "handoff",
      handoffGoal: "Finish the handoff",
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

    expect(await controller.handleSessionTree(sessionPath)).toBe(true);
    expect(await controller.handleSessionCompact(sessionPath)).toBe(true);

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

  it("queues behind a long-held concurrent write lock instead of failing", async () => {
    const root = testFs.createTempDir();
    const indexPath = path.join(root, "index.sqlite");
    const cwd = "/repo/app";

    const db = openIndexDatabase(indexPath, { create: true });
    initializeSchema(db);
    setMetadata(db, "indexed_at", "2026-03-22T00:00:00.000Z");
    db.close();

    const sessionPath = testFs.writeJsonlFile(root, "locked-wait.jsonl", [
      {
        type: "session",
        id: "locked-wait",
        timestamp: "2026-03-22T00:00:00.000Z",
        cwd,
      },
    ]);

    const controller = createSessionHookController({ indexPath });
    // The lock holder lives on a worker thread because the sqlite driver blocks
    // the main thread synchronously while it waits for the lock. A writer without
    // busy_timeout fails the instant it finds the lock held, so any hold at all
    // separates queueing from failing; keep it far below the timeout so a loaded
    // machine cannot push the wait past it.
    const lockHolder = await holdWriteLockInWorker(indexPath, 1000);

    try {
      expect(await controller.handleTurnEnd(sessionPath)).toBe(true);
    } finally {
      await lockHolder.released;
    }

    const indexedDb = openIndexDatabase(indexPath, { create: false });
    const lastHookEvent = getMetadata(indexedDb, "hook_last_event");
    indexedDb.close();
    expect(lastHookEvent).toBe("turn_end");
  }, 15_000);

  it("indexes appended entries incrementally without rewriting existing chunks", async () => {
    const root = testFs.createTempDir();
    const indexPath = path.join(root, "index.sqlite");
    const cwd = "/repo/app";

    const db = openIndexDatabase(indexPath, { create: true });
    initializeSchema(db);
    setMetadata(db, "indexed_at", "2026-03-22T00:00:00.000Z");
    db.close();

    const sessionPath = testFs.writeJsonlFile(root, "incremental.jsonl", [
      {
        type: "session",
        id: "incremental-session",
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
          content: [{ type: "text", text: "first turn prompt" }],
        },
      },
    ]);

    const controller = createSessionHookController({ indexPath });
    expect(await controller.handleTurnEnd(sessionPath)).toBe(true);

    // Sentinel: an incremental sync must not touch previously indexed chunks,
    // while a full re-extract would replace this text with the file contents.
    const sentinelDb = openIndexDatabase(indexPath, { create: false });
    sentinelDb
      .prepare(`UPDATE session_text_chunks SET text = ? WHERE source_kind = 'user_text'`)
      .run("sentinel-incremental-marker");
    sentinelDb.close();

    appendFileSync(
      sessionPath,
      `${JSON.stringify({
        type: "message",
        id: "assistant-1",
        parentId: "user-1",
        timestamp: "2026-03-22T00:00:02.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "freshly appended assistant reply" }],
        },
      })}\n`,
    );

    expect(await controller.handleTurnEnd(sessionPath)).toBe(true);

    const indexedDb = openIndexDatabase(indexPath, { create: false });
    const sentinelCount = indexedDb
      .prepare(`SELECT COUNT(*) as count FROM session_text_chunks WHERE text = ?`)
      .get("sentinel-incremental-marker") as { count: number };
    const appendedHits = searchSessions(indexedDb, {
      query: "freshly appended assistant",
      limit: 10,
    });
    const sessionStats = indexedDb
      .prepare(
        `SELECT message_count as messageCount, entry_count as entryCount FROM sessions WHERE session_id = ?`,
      )
      .get("incremental-session") as { messageCount: number; entryCount: number };
    indexedDb.close();

    expect(sentinelCount.count).toBe(1);
    expect(appendedHits.map((result) => result.sessionId)).toContain("incremental-session");
    expect(sessionStats).toEqual({ messageCount: 2, entryCount: 2 });
  });

  it("skips the session write entirely when the file is unchanged", async () => {
    const root = testFs.createTempDir();
    const indexPath = path.join(root, "index.sqlite");
    const cwd = "/repo/app";

    const db = openIndexDatabase(indexPath, { create: true });
    initializeSchema(db);
    setMetadata(db, "indexed_at", "2026-03-22T00:00:00.000Z");
    db.close();

    const sessionPath = testFs.writeJsonlFile(root, "skip.jsonl", [
      {
        type: "session",
        id: "skip-session",
        timestamp: "2026-03-22T00:00:00.000Z",
        cwd,
      },
    ]);

    const controller = createSessionHookController({ indexPath });
    expect(await controller.handleTurnEnd(sessionPath)).toBe(true);

    // Any sync path that writes the session row resets index_source to "hook".
    const sentinelDb = openIndexDatabase(indexPath, { create: false });
    sentinelDb
      .prepare(`UPDATE sessions SET index_source = 'sentinel' WHERE session_id = ?`)
      .run("skip-session");
    sentinelDb.close();

    expect(await controller.handleSessionTree(sessionPath)).toBe(true);

    const indexedDb = openIndexDatabase(indexPath, { create: false });
    const row = indexedDb
      .prepare(`SELECT index_source as indexSource FROM sessions WHERE session_id = ?`)
      .get("skip-session") as { indexSource: string };
    const lastHookEvent = getMetadata(indexedDb, "hook_last_event");
    indexedDb.close();

    expect(row.indexSource).toBe("sentinel");
    expect(lastHookEvent).toBe("session_tree");
  });

  it("falls back to a full re-extract when the file is rewritten in place", async () => {
    const root = testFs.createTempDir();
    const indexPath = path.join(root, "index.sqlite");
    const cwd = "/repo/app";

    const db = openIndexDatabase(indexPath, { create: true });
    initializeSchema(db);
    setMetadata(db, "indexed_at", "2026-03-22T00:00:00.000Z");
    db.close();

    const sessionPath = testFs.writeJsonlFile(root, "rewrite.jsonl", [
      {
        type: "session",
        id: "rewrite-session",
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
          content: [{ type: "text", text: "original prompt text" }],
        },
      },
    ]);

    const controller = createSessionHookController({ indexPath });
    expect(await controller.handleTurnEnd(sessionPath)).toBe(true);

    const sentinelDb = openIndexDatabase(indexPath, { create: false });
    sentinelDb
      .prepare(`UPDATE session_text_chunks SET text = ? WHERE source_kind = 'user_text'`)
      .run("sentinel-rewrite-marker");
    sentinelDb.close();

    testFs.writeJsonlFile(root, "rewrite.jsonl", [
      {
        type: "session",
        id: "rewrite-session",
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
          content: [{ type: "text", text: "completely rewritten prompt body" }],
        },
      },
      {
        type: "message",
        id: "user-2",
        parentId: "user-1",
        timestamp: "2026-03-22T00:00:02.000Z",
        message: {
          role: "user",
          content: [{ type: "text", text: "second rewritten message" }],
        },
      },
    ]);

    expect(await controller.handleTurnEnd(sessionPath)).toBe(true);

    const indexedDb = openIndexDatabase(indexPath, { create: false });
    const sentinelCount = indexedDb
      .prepare(`SELECT COUNT(*) as count FROM session_text_chunks WHERE text = ?`)
      .get("sentinel-rewrite-marker") as { count: number };
    const rewrittenHits = searchSessions(indexedDb, {
      query: "completely rewritten prompt",
      limit: 10,
    });
    const sessionStats = indexedDb
      .prepare(`SELECT message_count as messageCount FROM sessions WHERE session_id = ?`)
      .get("rewrite-session") as { messageCount: number };
    indexedDb.close();

    expect(sentinelCount.count).toBe(0);
    expect(rewrittenHits.map((result) => result.sessionId)).toContain("rewrite-session");
    expect(sessionStats.messageCount).toBe(2);
  });

  it("replaces the session-name chunk when a rename is appended", async () => {
    const root = testFs.createTempDir();
    const indexPath = path.join(root, "index.sqlite");
    const cwd = "/repo/app";

    const db = openIndexDatabase(indexPath, { create: true });
    initializeSchema(db);
    setMetadata(db, "indexed_at", "2026-03-22T00:00:00.000Z");
    db.close();

    const sessionPath = testFs.writeJsonlFile(root, "rename.jsonl", [
      {
        type: "session",
        id: "rename-session",
        timestamp: "2026-03-22T00:00:00.000Z",
        cwd,
      },
      {
        type: "session_info",
        id: "info-1",
        parentId: null,
        timestamp: "2026-03-22T00:00:01.000Z",
        name: "Original name",
      },
    ]);

    const controller = createSessionHookController({ indexPath });
    expect(await controller.handleTurnEnd(sessionPath)).toBe(true);

    appendFileSync(
      sessionPath,
      `${JSON.stringify({
        type: "session_info",
        id: "info-2",
        parentId: "info-1",
        timestamp: "2026-03-22T00:00:02.000Z",
        name: "Renamed by auto-title",
      })}\n`,
    );

    expect(await controller.handleTurnEnd(sessionPath)).toBe(true);

    const indexedDb = openIndexDatabase(indexPath, { create: false });
    const nameChunks = indexedDb
      .prepare(
        `SELECT text FROM session_text_chunks WHERE session_id = ? AND source_kind = 'session_name'`,
      )
      .all("rename-session") as Array<{ text: string }>;
    const sessionName = indexedDb
      .prepare(`SELECT session_name as name FROM sessions WHERE session_id = ?`)
      .get("rename-session") as { name: string };
    indexedDb.close();

    expect(nameChunks).toEqual([{ text: "Renamed by auto-title" }]);
    expect(sessionName.name).toBe("Renamed by auto-title");
  });

  it("refreshes lineage for the affected family only", async () => {
    const root = testFs.createTempDir();
    const indexPath = path.join(root, "index.sqlite");
    const cwd = "/repo/app";

    const db = openIndexDatabase(indexPath, { create: true });
    initializeSchema(db);
    setMetadata(db, "indexed_at", "2026-03-22T00:00:00.000Z");
    db.close();

    const writeSession = (name: string, id: string, parentSession?: string) =>
      testFs.writeJsonlFile(root, name, [
        {
          type: "session",
          id,
          timestamp: "2026-03-22T00:00:00.000Z",
          cwd,
          ...(parentSession ? { parentSession } : {}),
        },
      ]);

    const famAParent = writeSession("fam-a-parent.jsonl", "fam-a-parent");
    const famAChild = writeSession("fam-a-child.jsonl", "fam-a-child", famAParent);
    const famBParent = writeSession("fam-b-parent.jsonl", "fam-b-parent");
    const famBChild = writeSession("fam-b-child.jsonl", "fam-b-child", famBParent);

    const controller = createSessionHookController({ indexPath });
    for (const sessionPath of [famAParent, famAChild, famBParent, famBChild]) {
      expect(await controller.handleTurnEnd(sessionPath)).toBe(true);
    }

    const beforeDb = openIndexDatabase(indexPath, { create: false });
    const famBRowids = beforeDb
      .prepare(
        `SELECT rowid FROM session_lineage_relations WHERE session_id IN ('fam-b-parent', 'fam-b-child') ORDER BY rowid`,
      )
      .all() as Array<{ rowid: number }>;
    beforeDb.close();
    expect(famBRowids.length).toBeGreaterThan(0);

    const famAGrandchild = writeSession("fam-a-grandchild.jsonl", "fam-a-grandchild", famAChild);
    expect(await controller.handleTurnEnd(famAGrandchild)).toBe(true);

    const afterDb = openIndexDatabase(indexPath, { create: false });
    // A scoped refresh leaves family B's rows physically untouched; a global
    // rebuild reinserts them under new rowids.
    const famBRowidsAfter = afterDb
      .prepare(
        `SELECT rowid FROM session_lineage_relations WHERE session_id IN ('fam-b-parent', 'fam-b-child') ORDER BY rowid`,
      )
      .all() as Array<{ rowid: number }>;
    const grandchildRelations = afterDb
      .prepare(
        `SELECT related_session_id as relatedId, relation FROM session_lineage_relations WHERE session_id = 'fam-a-grandchild' ORDER BY related_session_id`,
      )
      .all() as Array<{ relatedId: string; relation: string }>;
    afterDb.close();

    expect(famBRowidsAfter).toEqual(famBRowids);
    expect(grandchildRelations).toEqual([
      { relatedId: "fam-a-child", relation: "parent" },
      { relatedId: "fam-a-grandchild", relation: "self" },
      { relatedId: "fam-a-parent", relation: "ancestor" },
    ]);
  });

  it("searches session ids without storing session-id FTS chunks after a hook sync", async () => {
    const root = testFs.createTempDir();
    const indexPath = path.join(root, "index.sqlite");
    const cwd = "/repo/app";

    const db = openIndexDatabase(indexPath, { create: true });
    initializeSchema(db);
    setMetadata(db, "indexed_at", "2026-03-22T00:00:00.000Z");
    db.close();

    const sessionPath = testFs.writeJsonlFile(root, "id-chunk.jsonl", [
      {
        type: "session",
        id: "0196fb52-f615-7321-a3b6-9e0e1a90d4c2",
        timestamp: "2026-03-22T00:00:00.000Z",
        cwd,
      },
    ]);

    const controller = createSessionHookController({ indexPath });
    expect(await controller.handleTurnEnd(sessionPath)).toBe(true);

    const indexedDb = openIndexDatabase(indexPath, { create: false });
    const idChunks = indexedDb
      .prepare(
        `SELECT COUNT(*) as count FROM session_text_chunks WHERE session_id = ? AND source_kind = 'session_id'`,
      )
      .get("0196fb52-f615-7321-a3b6-9e0e1a90d4c2") as { count: number };
    const hits = searchSessions(indexedDb, {
      query: "0196fb52-f615-7321-a3b6-9e0e1a90d4c2",
      limit: 10,
    });
    indexedDb.close();

    expect(idChunks.count).toBe(0);
    expect(hits[0]?.sessionId).toBe("0196fb52-f615-7321-a3b6-9e0e1a90d4c2");
  });
});

const WRITE_LOCK_HOLDER_SCRIPT = `
const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(workerData.dbPath);
db.exec("PRAGMA busy_timeout = 0");
db.exec("BEGIN IMMEDIATE");
db.prepare(
  "INSERT INTO metadata(key, value) VALUES ('lock-holder', '1') ON CONFLICT(key) DO UPDATE SET value = '1'",
).run();
parentPort.postMessage("locked");
setTimeout(() => {
  db.exec("COMMIT");
  db.close();
}, workerData.holdMs);
`;

async function holdWriteLockInWorker(
  dbPath: string,
  holdMs: number,
): Promise<{ released: Promise<void> }> {
  const worker = new Worker(WRITE_LOCK_HOLDER_SCRIPT, {
    eval: true,
    workerData: { dbPath, holdMs },
  });

  await new Promise<void>((resolve, reject) => {
    worker.once("message", () => resolve());
    worker.once("error", reject);
  });

  return {
    released: new Promise<void>((resolve, reject) => {
      worker.once("exit", () => resolve());
      worker.once("error", reject);
    }),
  };
}
