import { readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { rebuildSessionIndex } from "../extensions/session-search/reindex.ts";
import {
  initializeSchema,
  openIndexDatabase,
  searchSessions,
  upsertSession,
} from "../extensions/shared/session-index/index.ts";
import { createTestFilesystem } from "./test-helpers.ts";

const testFs = createTestFilesystem("pi-sessions-reindex-");

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  testFs.cleanup();
});

describe("rebuildSessionIndex", () => {
  it("matches native discovery depth and follows linked directories and files", async () => {
    const root = testFs.createTempDir();
    const sessions = testFs.ensureDir(path.join(root, "sessions"));
    const project = testFs.ensureDir(path.join(sessions, "project"));
    const external = testFs.ensureDir(path.join(root, "external"));
    const header = (id: string) => ({
      type: "session",
      version: 3,
      id,
      timestamp: "2026-03-22T00:00:00.000Z",
      cwd: root,
    });
    testFs.writeJsonlFile(sessions, "ignored-root.jsonl", [header("root")]);
    testFs.writeJsonlFile(path.join(project, "nested"), "ignored-deep.jsonl", [header("deep")]);
    testFs.writeJsonlFile(project, "valid.jsonl", [header("valid")]);
    testFs.writeJsonlFile(external, "linked-dir.jsonl", [header("linked-dir")]);
    const file = testFs.writeJsonlFile(root, "linked-file.jsonl", [header("linked-file")]);
    symlinkSync(external, path.join(sessions, "external"));
    symlinkSync(file, path.join(project, "linked-file.jsonl"));
    symlinkSync(path.join(root, "missing"), path.join(project, "aaa-broken.jsonl"));
    symlinkSync("aab-loop.jsonl", path.join(project, "aab-loop.jsonl"));
    symlinkSync("loop-dir", path.join(sessions, "loop-dir"));
    symlinkSync(path.join(root, "missing"), path.join(sessions, "broken-dir"));
    writeFileSync(path.join(project, "invalid.jsonl"), "{garbage\n");
    testFs.ensureDir(path.join(project, "directory.jsonl"));
    vi.stubEnv("PI_CODING_AGENT_DIR", root);
    const nativeIds = (await SessionManager.listAll()).map((session) => session.id).sort();
    const indexPath = path.join(root, "index.sqlite");
    const result = await rebuildSessionIndex({ indexPath });
    const db = openIndexDatabase(indexPath);
    const indexedIds = searchSessions(db, { limit: 10 })
      .map((session) => session.sessionId)
      .sort();
    expect(indexedIds).toEqual(["linked-dir", "linked-file", "valid"]);
    expect(indexedIds).toEqual(nativeIds);
    expect(result.sessionCount).toBe(3);
    db.close();
  });

  it("chooses the newest duplicate ID and breaks timestamp ties by sorted path", async () => {
    const root = testFs.createTempDir();
    const directory = path.join(root, "sessions", "project");
    for (const [name, timestamp] of [
      ["a", "2026-03-23T00:00:00.000Z"],
      ["b", "2026-03-23T00:00:00.000Z"],
      ["z", "2026-03-22T00:00:00.000Z"],
    ]) {
      testFs.writeJsonlFile(directory, `${name}.jsonl`, [
        { type: "session", id: "duplicate", timestamp, cwd: root },
        {
          type: "message",
          id: name,
          timestamp,
          parentId: null,
          message: { role: "user", content: `duplicate ${name}` },
        },
      ]);
    }
    vi.stubEnv("PI_CODING_AGENT_DIR", root);
    const indexPath = path.join(root, "index.sqlite");
    for (let run = 0; run < 2; run++) {
      const result = await rebuildSessionIndex({ indexPath });
      expect(result).toMatchObject({ sessionCount: 1, chunkCount: 1 });
      const db = openIndexDatabase(indexPath);
      expect(searchSessions(db, { limit: 10 })[0]?.sessionPath).toBe(
        path.join(directory, "b.jsonl"),
      );
      db.close();
    }
  });

  it("indexes sessions, repo roots, and file touches from disk", async () => {
    const root = testFs.createTempDir();
    const sessionsDir = path.join(root, "sessions");
    const nestedDir = path.join(sessionsDir, "--repo--");
    const indexPath = path.join(root, "index.sqlite");
    const repoRoot = testFs.ensureDir(path.join(root, "repo"));
    testFs.ensureDir(path.join(repoRoot, ".git"));
    const cwd = testFs.ensureDir(path.join(repoRoot, "app"));

    testFs.writeJsonlFile(nestedDir, "2026-03-22T00-00-00-000Z_demo.jsonl", [
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

    vi.stubEnv("PI_CODING_AGENT_DIR", root);
    const listAll = vi.spyOn(SessionManager, "listAll");

    const result = await rebuildSessionIndex({ indexPath });
    expect(listAll).not.toHaveBeenCalled();
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
    expect(fileHits[0]?.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "file_touch",
          op: "changed",
          path: "app/src/index.ts",
        }),
      ]),
    );
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
    testFs.writeJsonlFile(nestedDir, "2026-03-22T00-10-00-000Z_child.jsonl", [
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
          title: "Implement autocomplete",
          initial_prompt: "Finish the split",
          launch: "deferred",
        },
      },
    ]);

    vi.stubEnv("PI_CODING_AGENT_DIR", root);

    await rebuildSessionIndex({ indexPath });

    const db = openIndexDatabase(indexPath, { create: false });
    const childRow = db
      .prepare(
        `SELECT parent_session_path as parentSessionPath, parent_session_id as parentSessionId, session_origin as sessionOrigin, handoff_goal as handoffGoal FROM sessions WHERE session_id = ?`,
      )
      .get("child-session") as {
      parentSessionPath?: string;
      parentSessionId?: string;
      sessionOrigin?: string;
      handoffGoal?: string;
    };
    db.close();

    expect(childRow).toEqual({
      parentSessionPath: parentPath,
      parentSessionId: "parent-session",
      sessionOrigin: "handoff",
      handoffGoal: "Finish the split",
    });
  });

  it("does not materialize lineage to sessions excluded from the reindex", async () => {
    const root = testFs.createTempDir();
    const nestedDir = path.join(root, "sessions", "--repo--");
    const indexPath = path.join(root, "index.sqlite");
    const cwd = "/repo/app";

    const parentPath = testFs.writeJsonlFile(root, "parent.jsonl", [
      {
        type: "session",
        id: "excluded-parent",
        timestamp: "2026-03-22T00:00:00.000Z",
        cwd,
      },
    ]);
    testFs.writeJsonlFile(nestedDir, "child.jsonl", [
      {
        type: "session",
        id: "indexed-child",
        timestamp: "2026-03-22T00:10:00.000Z",
        cwd,
        parentSession: parentPath,
      },
    ]);

    vi.stubEnv("PI_CODING_AGENT_DIR", root);

    await rebuildSessionIndex({ indexPath });

    const db = openIndexDatabase(indexPath, { create: false });
    const child = db
      .prepare(`SELECT parent_session_id as parentSessionId FROM sessions WHERE session_id = ?`)
      .get("indexed-child");
    const relations = db
      .prepare(
        `SELECT related_session_id as relatedSessionId FROM session_lineage_relations WHERE session_id = ?`,
      )
      .all("indexed-child");
    db.close();

    expect(child).toEqual({ parentSessionId: "excluded-parent" });
    expect(relations).toEqual([{ relatedSessionId: "indexed-child" }]);
  });

  it("rebuilds in place so connections opened before the rebuild see the new data", async () => {
    const root = testFs.createTempDir();
    const sessionsDir = path.join(root, "sessions");
    const nestedDir = path.join(sessionsDir, "--repo--");
    const indexPath = path.join(root, "index.sqlite");
    const cwd = "/repo/app";

    const seedDb = openIndexDatabase(indexPath, { create: true });
    initializeSchema(seedDb);
    upsertSession(
      seedDb,
      {
        sessionId: "stale-session",
        sessionPath: "/tmp/deleted-session.jsonl",
        sessionName: "Deleted session",
        cwd,
        repoRoots: [],
        startedAt: "2026-03-21T00:00:00.000Z",
        modifiedAt: "2026-03-21T00:00:00.000Z",
        messageCount: 0,
        entryCount: 1,
      },
      "hook",
    );
    seedDb.close();

    // Simulates another pi process holding a connection while the rebuild runs.
    // Replacing the database file out from under it would strand it on the old
    // inode and leave the old WAL sidecar next to the new file.
    const observer = openIndexDatabase(indexPath, { create: false });

    testFs.writeJsonlFile(nestedDir, "2026-03-22T00-00-00-000Z_live.jsonl", [
      {
        type: "session",
        id: "live-session",
        timestamp: "2026-03-22T00:00:00.000Z",
        cwd,
      },
    ]);

    vi.stubEnv("PI_CODING_AGENT_DIR", root);

    await rebuildSessionIndex({ indexPath });

    const observedIds = observer
      .prepare(`SELECT session_id as sessionId FROM sessions ORDER BY session_id`)
      .all() as Array<{ sessionId: string }>;
    observer.close();

    expect(observedIds).toEqual([{ sessionId: "live-session" }]);
  });
});
