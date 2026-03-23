import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatHandoffRef, resolveSessionReference } from "../extensions/session-handoff/refs.js";
import {
  initializeSchema,
  insertSession,
  openIndexDatabase,
  setMetadata,
} from "../extensions/session-search/db.js";
import { createTestFilesystem } from "./test-helpers.js";

const testFs = createTestFilesystem("pi-sessions-handoff-refs-");

afterEach(() => {
  delete process.env.PI_SESSIONS_INDEX_DIR;
  testFs.cleanup();
});

describe("session handoff refs", () => {
  it("formats canonical handoff refs", () => {
    expect(formatHandoffRef("session-123")).toBe("@handoff/session-123");
  });

  it("resolves absolute session paths without the index", () => {
    const sessionPath = testFs.writeJsonlFile(testFs.createTempDir(), "session.jsonl", [
      {
        type: "session",
        id: "session-absolute",
        timestamp: "2026-03-23T00:00:00.000Z",
        cwd: "/repo/app",
      },
      {
        type: "session_info",
        id: "info-1",
        parentId: null,
        timestamp: "2026-03-23T00:00:01.000Z",
        name: "Absolute path session",
      },
    ]);

    const result = resolveSessionReference(sessionPath);

    expect(result.error).toBeUndefined();
    expect(result.resolved).toMatchObject({
      kind: "path",
      sessionId: "session-absolute",
      sessionPath,
      canonicalRef: "@handoff/session-absolute",
    });
  });

  it("resolves raw session ids and canonical handoff refs through the index", () => {
    const root = testFs.createTempDir();
    const indexDir = testFs.ensureDir(path.join(root, "index"));
    const dbPath = path.join(indexDir, "index.sqlite");
    process.env.PI_SESSIONS_INDEX_DIR = indexDir;

    const db = openIndexDatabase(dbPath, { create: true });
    initializeSchema(db);
    setMetadata(db, "indexed_at", "2026-03-23T00:00:00.000Z");
    insertSession(
      db,
      {
        sessionId: "parent-session-1234",
        sessionPath: "/tmp/parent.jsonl",
        sessionName: "Parent",
        cwd: "/repo/app",
        repoRoots: ["/repo"],
        startedAt: "2026-03-23T00:00:00.000Z",
        modifiedAt: "2026-03-23T00:10:00.000Z",
        messageCount: 2,
        entryCount: 3,
      },
      "full_reindex",
    );
    insertSession(
      db,
      {
        sessionId: "child-session-5678",
        sessionPath: "/tmp/child.jsonl",
        sessionName: "Child",
        cwd: "/repo/app",
        repoRoots: ["/repo"],
        startedAt: "2026-03-23T00:11:00.000Z",
        modifiedAt: "2026-03-23T00:12:00.000Z",
        messageCount: 2,
        entryCount: 3,
        parentSessionPath: "/tmp/parent.jsonl",
        parentSessionId: "parent-session-1234",
        sessionOrigin: "handoff",
      },
      "full_reindex",
    );
    db.close();

    const byId = resolveSessionReference("child-session-5678");
    const byRef = resolveSessionReference("@handoff/child-session-5678");

    expect(byId.error).toBeUndefined();
    expect(byId.resolved).toMatchObject({
      kind: "session_id",
      sessionId: "child-session-5678",
      sessionPath: "/tmp/child.jsonl",
      sessionOrigin: "handoff",
    });
    expect(byRef.error).toBeUndefined();
    expect(byRef.resolved).toMatchObject({
      kind: "handoff_ref",
      sessionId: "child-session-5678",
      canonicalRef: "@handoff/child-session-5678",
    });
  });

  it("fails clearly on partial handoff refs", () => {
    const root = testFs.createTempDir();
    const indexDir = testFs.ensureDir(path.join(root, "index"));
    const dbPath = path.join(indexDir, "index.sqlite");
    process.env.PI_SESSIONS_INDEX_DIR = indexDir;

    const db = openIndexDatabase(dbPath, { create: true });
    initializeSchema(db);
    setMetadata(db, "indexed_at", "2026-03-23T00:00:00.000Z");
    insertSession(
      db,
      {
        sessionId: "shared-prefix-a",
        sessionPath: "/tmp/a.jsonl",
        sessionName: "A",
        cwd: "/repo/app",
        repoRoots: ["/repo"],
        startedAt: "2026-03-23T00:00:00.000Z",
        modifiedAt: "2026-03-23T00:01:00.000Z",
        messageCount: 1,
        entryCount: 1,
      },
      "full_reindex",
    );
    insertSession(
      db,
      {
        sessionId: "shared-prefix-b",
        sessionPath: "/tmp/b.jsonl",
        sessionName: "B",
        cwd: "/repo/app",
        repoRoots: ["/repo"],
        startedAt: "2026-03-23T00:02:00.000Z",
        modifiedAt: "2026-03-23T00:03:00.000Z",
        messageCount: 1,
        entryCount: 1,
      },
      "full_reindex",
    );
    db.close();

    const result = resolveSessionReference("@handoff/shared-prefix");

    expect(result.resolved).toBeUndefined();
    expect(result.error).toContain("No session found");
  });
});
