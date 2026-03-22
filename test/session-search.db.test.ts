import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildSearchSessionsQuery,
  clearSessionIndexedData,
  getIndexStatus,
  getMetadata,
  INDEX_SCHEMA_VERSION,
  initializeSchema,
  insertSession,
  insertSessionFileTouch,
  insertTextChunk,
  openIndexDatabase,
  setMetadata,
  upsertSession,
} from "../extensions/session-search/db.js";
import { createTestFilesystem } from "./test-helpers.js";

const testFs = createTestFilesystem("pi-sessions-db-");

afterEach(() => {
  testFs.cleanup();
});

describe("session-search db", () => {
  it("creates schema, reports status, and filters by repo and files", () => {
    const dir = testFs.createTempDir();
    const dbPath = path.join(dir, "index.sqlite");
    const repoRoot = path.join(dir, "repo");

    const db = openIndexDatabase(dbPath, { create: true });
    initializeSchema(db);
    setMetadata(db, "indexed_at", "2026-03-22T00:00:00.000Z");
    insertSession(
      db,
      {
        sessionId: "session-1",
        sessionPath: "/tmp/session-1.jsonl",
        sessionName: "Repo work",
        cwd: `${repoRoot}/app`,
        repoRoots: [repoRoot],
        startedAt: "2026-03-22T00:00:00.000Z",
        modifiedAt: "2026-03-22T00:10:00.000Z",
        messageCount: 2,
        entryCount: 3,
      },
      "full_reindex",
    );
    insertSessionFileTouch(db, {
      sessionId: "session-1",
      entryId: "assistant-1",
      op: "changed",
      source: "tool_call",
      rawPath: "src/index.ts",
      absPath: `${repoRoot}/app/src/index.ts`,
      cwdRelPath: "src/index.ts",
      repoRoot,
      repoRelPath: "app/src/index.ts",
      basename: "index.ts",
      pathScope: "relative",
      ts: "2026-03-22T00:05:00.000Z",
    });
    db.close();

    const status = getIndexStatus(dbPath);
    expect(status.exists).toBe(true);
    expect(status.schemaVersion).toBe(INDEX_SCHEMA_VERSION);
    expect(status.lastFullReindexAt).toBe("2026-03-22T00:00:00.000Z");
    expect(status.sessionCount).toBe(1);

    const searchDb = openIndexDatabase(dbPath, { create: false });
    const repoHits = buildSearchSessionsQuery(searchDb, { repo: repoRoot, limit: 10 });
    const fileHits = buildSearchSessionsQuery(searchDb, {
      touched: ["src/index.ts"],
      limit: 10,
    });
    searchDb.close();

    expect(repoHits).toHaveLength(1);
    expect(fileHits).toHaveLength(1);
    expect(fileHits[0]?.matchedFiles).toEqual(["app/src/index.ts"]);
    expect(fileHits[0]?.score).toBeGreaterThan(0);
  });

  it("upserts sessions and clears indexed session data", () => {
    const dir = testFs.createTempDir();
    const dbPath = path.join(dir, "index.sqlite");

    const db = openIndexDatabase(dbPath, { create: true });
    initializeSchema(db);
    insertSession(
      db,
      {
        sessionId: "session-1",
        sessionPath: "/tmp/session-1.jsonl",
        sessionName: "Before",
        cwd: "/repo/app",
        repoRoots: ["/repo"],
        startedAt: "2026-03-22T00:00:00.000Z",
        modifiedAt: "2026-03-22T00:01:00.000Z",
        messageCount: 1,
        entryCount: 2,
      },
      "full_reindex",
    );
    insertTextChunk(db, {
      sessionId: "session-1",
      entryId: "entry-1",
      entryType: "message",
      role: "assistant",
      ts: "2026-03-22T00:00:30.000Z",
      sourceKind: "assistant_text",
      text: "before text",
    });
    insertSessionFileTouch(db, {
      sessionId: "session-1",
      entryId: "entry-1",
      op: "changed",
      source: "tool_call",
      rawPath: "src/index.ts",
      absPath: "/repo/app/src/index.ts",
      cwdRelPath: "src/index.ts",
      repoRoot: "/repo",
      repoRelPath: "app/src/index.ts",
      basename: "index.ts",
      pathScope: "relative",
      ts: "2026-03-22T00:00:40.000Z",
    });

    upsertSession(
      db,
      {
        sessionId: "session-1",
        sessionPath: "/tmp/session-1.jsonl",
        sessionName: "After",
        cwd: "/repo/app",
        repoRoots: ["/repo"],
        startedAt: "2026-03-22T00:00:00.000Z",
        modifiedAt: "2026-03-22T00:02:00.000Z",
        messageCount: 3,
        entryCount: 4,
      },
      "hook",
    );

    const beforeClear = db
      .prepare(
        `SELECT session_name as name, index_source as source FROM sessions WHERE session_id = ?`,
      )
      .get("session-1") as { name: string; source: string };
    expect(beforeClear).toEqual({ name: "After", source: "hook" });

    clearSessionIndexedData(db, "session-1");

    const chunkCount = db
      .prepare(`SELECT COUNT(*) as count FROM session_text_chunks WHERE session_id = ?`)
      .get("session-1") as { count: number };
    const touchCount = db
      .prepare(`SELECT COUNT(*) as count FROM session_file_touches WHERE session_id = ?`)
      .get("session-1") as { count: number };
    const ftsCount = db
      .prepare(`SELECT COUNT(*) as count FROM session_text_chunks_fts WHERE session_id = ?`)
      .get("session-1") as { count: number };
    const schemaVersion = getMetadata(db, "schema_version");
    db.close();

    expect(chunkCount.count).toBe(0);
    expect(touchCount.count).toBe(0);
    expect(ftsCount.count).toBe(0);
    expect(schemaVersion).toBe(String(INDEX_SCHEMA_VERSION));
  });
});
