import { appendFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extractSessionRecord } from "../extensions/session-search/extract.ts";
import {
  getAncestorSessions,
  getChildSessions,
  getLineageSessions,
  getParentSession,
  getSiblingSessions,
  initializeSchema,
  insertSession,
  openIndexDatabase,
  rebuildSessionLineageRelations,
} from "../extensions/shared/session-index/index.ts";
import { createSessionHookController } from "../extensions/shared/session-index/sync.ts";
import { createTestFilesystem } from "./test-helpers.ts";

const testFs = createTestFilesystem("pi-sessions-handoff-lineage-");

afterEach(() => {
  testFs.cleanup();
});

describe("session handoff lineage", () => {
  it("indexes extension lineage appended after startup, even without a parent file", async () => {
    const dir = testFs.createTempDir();
    const dbPath = path.join(dir, "index.sqlite");
    const db = openIndexDatabase(dbPath, { create: true });
    initializeSchema(db);
    db.close();
    const parent = testFs.writeJsonlFile(dir, "parent.jsonl", [
      { type: "session", id: "parent", cwd: dir, timestamp: "2026-03-23T00:00:00.000Z" },
    ]);
    const child = testFs.writeJsonlFile(dir, "child.jsonl", [
      { type: "session", id: "child", cwd: dir, timestamp: "2026-03-23T00:00:00.000Z" },
    ]);
    const hooks = createSessionHookController({ indexPath: dbPath });
    await hooks.handleSessionStart(parent);
    await hooks.handleSessionStart(child);
    appendFileSync(
      child,
      `${JSON.stringify({ type: "custom", id: "lineage", parentId: null, timestamp: "2026-03-23T00:01:00.000Z", customType: "pi-sessions.lineage", data: { parentSessionId: "parent" } })}\n`,
    );
    expect(await hooks.handleTurnEnd(child)).toBe(true);
    const indexed = openIndexDatabase(dbPath);
    try {
      expect(getParentSession(indexed, "child")?.sessionId).toBe("parent");
    } finally {
      indexed.close();
    }
  });

  it("prefers header lineage and ignores malformed custom entries", () => {
    const dir = testFs.createTempDir();
    const headerParent = testFs.writeJsonlFile(dir, "header-parent.jsonl", [
      { type: "session", id: "header-parent", cwd: dir, timestamp: "2026-03-23T00:00:00.000Z" },
    ]);
    const entries = [
      {
        type: "custom",
        id: "bad",
        parentId: null,
        timestamp: "2026-03-23T00:01:00.000Z",
        customType: "pi-sessions.lineage",
        data: { parentSessionId: 42 },
      },
      {
        type: "custom",
        id: "good",
        parentId: "bad",
        timestamp: "2026-03-23T00:02:00.000Z",
        customType: "pi-sessions.lineage",
        data: { parentSessionId: "custom-parent", parentSessionFile: "/missing-parent.jsonl" },
      },
    ];
    const child = testFs.writeJsonlFile(dir, "child.jsonl", [
      { type: "session", id: "child", cwd: dir, timestamp: "2026-03-23T00:00:00.000Z" },
      ...entries,
    ]);
    expect(extractSessionRecord(child)).toMatchObject({
      parentSessionId: "custom-parent",
      parentSessionPath: "/missing-parent.jsonl",
    });
    const fork = testFs.writeJsonlFile(dir, "fork.jsonl", [
      {
        type: "session",
        id: "fork",
        cwd: dir,
        timestamp: "2026-03-23T00:00:00.000Z",
        parentSession: headerParent,
      },
      ...entries,
    ]);
    expect(extractSessionRecord(fork)).toMatchObject({
      parentSessionId: "header-parent",
      parentSessionPath: headerParent,
    });
  });

  it("walks parents, ancestors, children, and siblings", () => {
    const dbPath = path.join(testFs.createTempDir(), "index.sqlite");
    const db = openIndexDatabase(dbPath, { create: true });
    initializeSchema(db);

    insertSession(
      db,
      {
        sessionId: "root",
        sessionPath: "/tmp/root.jsonl",
        sessionName: "Root",
        cwd: "/repo/app",
        repoRoots: ["/repo"],
        startedAt: "2026-03-23T00:00:00.000Z",
        modifiedAt: "2026-03-23T00:00:00.000Z",
        messageCount: 1,
        entryCount: 1,
      },
      "full_reindex",
    );
    insertSession(
      db,
      {
        sessionId: "child-a",
        sessionPath: "/tmp/child-a.jsonl",
        sessionName: "Child A",
        cwd: "/repo/app",
        repoRoots: ["/repo"],
        startedAt: "2026-03-23T00:10:00.000Z",
        modifiedAt: "2026-03-23T00:10:00.000Z",
        messageCount: 1,
        entryCount: 1,
        parentSessionPath: "/tmp/root.jsonl",
        parentSessionId: "root",
        sessionOrigin: "handoff",
      },
      "full_reindex",
    );
    insertSession(
      db,
      {
        sessionId: "child-b",
        sessionPath: "/tmp/child-b.jsonl",
        sessionName: "Child B",
        cwd: "/repo/app",
        repoRoots: ["/repo"],
        startedAt: "2026-03-23T00:11:00.000Z",
        modifiedAt: "2026-03-23T00:11:00.000Z",
        messageCount: 1,
        entryCount: 1,
        parentSessionPath: "/tmp/root.jsonl",
        parentSessionId: "root",
        sessionOrigin: "fork",
      },
      "full_reindex",
    );
    insertSession(
      db,
      {
        sessionId: "grandchild",
        sessionPath: "/tmp/grandchild.jsonl",
        sessionName: "Grandchild",
        cwd: "/repo/app",
        repoRoots: ["/repo"],
        startedAt: "2026-03-23T00:20:00.000Z",
        modifiedAt: "2026-03-23T00:20:00.000Z",
        messageCount: 1,
        entryCount: 1,
        parentSessionPath: "/tmp/child-a.jsonl",
        parentSessionId: "child-a",
        sessionOrigin: "handoff",
      },
      "full_reindex",
    );

    rebuildSessionLineageRelations(db);

    const parent = getParentSession(db, "grandchild");
    const ancestors = getAncestorSessions(db, "grandchild");
    const children = getChildSessions(db, "root");
    const siblings = getSiblingSessions(db, "child-a");
    const lineage = getLineageSessions(db, "grandchild");

    db.close();

    expect(parent?.sessionId).toBe("child-a");
    expect(ancestors.map((session) => session.sessionId)).toEqual(["child-a", "root"]);
    expect(children.map((session) => session.sessionId)).toEqual(["child-b", "child-a"]);
    expect(siblings.map((session) => session.sessionId)).toEqual(["child-b"]);
    expect(lineage[0]).toMatchObject({
      sessionId: "grandchild",
      relation: "self",
      distance: 0,
    });
    expect(
      lineage.find(
        (session) =>
          session.sessionId === "child-b" &&
          session.relation === "ancestor_sibling" &&
          session.distance === 2,
      ),
    ).toBeDefined();
    expect(
      lineage.find((session) => session.sessionId === "root" && session.relation === "ancestor")
        ?.distance,
    ).toBe(2);
  });
});
