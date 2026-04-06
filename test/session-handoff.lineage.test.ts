import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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
} from "../extensions/session-search/db.js";
import { createTestFilesystem } from "./test-helpers.js";

const testFs = createTestFilesystem("pi-sessions-handoff-lineage-");

afterEach(() => {
  testFs.cleanup();
});

describe("session handoff lineage", () => {
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
