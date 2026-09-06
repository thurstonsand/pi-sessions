import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearSessionIndexedData,
  getIndexStatus,
  getMetadata,
  INDEX_SCHEMA_VERSION,
  initializeSchema,
  insertSession,
  insertSessionFileTouch,
  insertTextChunk,
  openIndexDatabase,
  searchSessionChunks,
  searchSessions,
  setMetadata,
  upsertSession,
  withSessionIndex,
} from "../extensions/shared/session-index/index.ts";
import { createTestFilesystem } from "./test-helpers.ts";

const testFs = createTestFilesystem("pi-sessions-db-");

afterEach(() => {
  testFs.cleanup();
});

describe("session-search db", () => {
  it.each(["needle", '"needle"', "needle extra", "needle AND extra"])(
    "fills the session budget despite long matching transcripts: %s",
    (query) => {
      const db = openIndexDatabase(path.join(testFs.createTempDir(), "index.sqlite"));
      initializeSchema(db);
      db.transaction(() => {
        for (let session = 0; session < 15; session++) {
          const sessionId = `result-${session}`;
          insertSession(
            db,
            {
              sessionId,
              sessionPath: `/tmp/${sessionId}.jsonl`,
              sessionName: sessionId,
              cwd: "/repo",
              repoRoots: [],
              startedAt: "2026-03-22T00:00:00.000Z",
              modifiedAt: new Date(Date.now() - (15 - session) * 3_600_000).toISOString(),
              messageCount: 300,
              entryCount: 300,
            },
            "full_reindex",
          );
          for (let entry = 0; entry < 300; entry++) {
            insertTextChunk(db, {
              sessionId,
              entryId: `${entry}`,
              entryType: "message",
              ts: "2026-03-22T00:00:00.000Z",
              sourceKind: "user_text",
              text: session < 3 ? "needle extra" : "needle extra filler",
            });
          }
        }
      });
      const hits = searchSessions(db, { query, limit: 10 });
      expect(hits).toHaveLength(10);
      expect(new Set(hits.map((hit) => hit.sessionId)).size).toBe(10);
      expect(hits.slice(0, 3).map((hit) => hit.sessionId)).toEqual([
        "result-2",
        "result-1",
        "result-0",
      ]);
      expect(hits.every((hit) => hit.evidence.length <= 20)).toBe(true);
      expect(searchSessions(db, { query, limit: 20 })).toHaveLength(15);
      db.close();
    },
  );

  it("does not load session metadata on a text or ID miss", () => {
    const db = openIndexDatabase(path.join(testFs.createTempDir(), "index.sqlite"));
    initializeSchema(db);
    const prepare = vi.spyOn(db, "prepare");
    expect(searchSessions(db, { query: "zz_benchmark_absent_82917" })).toEqual([]);
    expect(prepare.mock.calls.some(([sql]) => sql.includes("s.repo_roots_json"))).toBe(false);
    db.close();
  });

  it("applies a busy timeout to every connection", () => {
    const dir = testFs.createTempDir();
    const dbPath = path.join(dir, "index.sqlite");

    const db = openIndexDatabase(dbPath, { create: true });
    expect(db.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 });
    db.close();

    const customDb = openIndexDatabase(dbPath, { create: false, timeoutMs: 1234 });
    expect(customDb.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 1234 });
    customDb.close();
  });

  it("opens validated read connections in readonly mode", () => {
    const dir = testFs.createTempDir();
    const dbPath = path.join(dir, "index.sqlite");

    const db = openIndexDatabase(dbPath, { create: true });
    initializeSchema(db);
    db.close();

    expect(() =>
      withSessionIndex(dbPath, { mode: "read", required: true }, ({ db: readDb }) => {
        setMetadata(readDb, "should_not_write", "true");
      }),
    ).toThrow();
  });

  it("creates schema, reports status, and applies repo and file filters without ranking boosts", () => {
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
    insertSessionFileTouch(db, {
      sessionId: "session-1",
      entryId: "assistant-2",
      op: "changed",
      source: "tool_call",
      rawPath: "src/index.ts",
      absPath: `${repoRoot}/app/src/index.ts`,
      cwdRelPath: "src/index.ts",
      repoRoot,
      repoRelPath: "app/src/index.ts",
      basename: "index.ts",
      pathScope: "relative",
      ts: "2026-03-22T00:06:00.000Z",
    });
    db.close();

    const status = getIndexStatus(dbPath);
    expect(status.exists).toBe(true);
    expect(status.schemaVersion).toBe(INDEX_SCHEMA_VERSION);
    expect(status.lastFullReindexAt).toBe("2026-03-22T00:00:00.000Z");
    expect(status.sessionCount).toBe(1);

    const searchDb = openIndexDatabase(dbPath, { create: false });
    const repoHits = searchSessions(searchDb, { repo: repoRoot, limit: 10 });
    const fileHits = searchSessions(searchDb, {
      touched: ["src/index.ts"],
      limit: 10,
    });
    searchDb.close();

    expect(repoHits).toHaveLength(1);
    expect(fileHits).toHaveLength(1);
    expect(fileHits[0]?.evidence).toEqual([
      {
        kind: "file_touch",
        op: "changed",
        query: "src/index.ts",
        path: "app/src/index.ts",
        entryId: "assistant-1",
      },
    ]);
    expect(fileHits[0]?.score).toBe(0);
    expect(fileHits[0]?.hitCount).toBe(1);
  });

  it("filters indexed sessions by user or subagent kind", () => {
    const dir = testFs.createTempDir();
    const dbPath = path.join(dir, "index.sqlite");
    const db = openIndexDatabase(dbPath, { create: true });
    initializeSchema(db);
    for (const [sessionId, sessionOrigin] of [
      ["root-session", undefined],
      ["handoff-session", "handoff"],
      ["subagent-session", "subagent"],
    ] as const) {
      insertSession(
        db,
        {
          sessionId,
          sessionPath: `/tmp/${sessionId}.jsonl`,
          sessionName: sessionId,
          cwd: "/repo",
          repoRoots: ["/repo"],
          startedAt: "2026-03-22T00:00:00.000Z",
          modifiedAt: "2026-03-22T00:00:00.000Z",
          messageCount: 1,
          entryCount: 1,
          sessionOrigin,
        },
        "full_reindex",
      );
    }

    expect(searchSessions(db, { kind: "subagent" }).map((row) => row.sessionId)).toEqual([
      "subagent-session",
    ]);
    expect(searchSessions(db, { kind: "user" }).map((row) => row.sessionId)).toEqual([
      "root-session",
      "handoff-session",
    ]);
    db.close();
  });

  it("searches text chunks as scoped entry-level hits", () => {
    const dir = testFs.createTempDir();
    const dbPath = path.join(dir, "index.sqlite");

    const db = openIndexDatabase(dbPath, { create: true });
    initializeSchema(db);
    insertSession(
      db,
      {
        sessionId: "session-1",
        sessionPath: "/tmp/session-1.jsonl",
        sessionName: "First",
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
        sessionName: "Second",
        cwd: "/repo/app",
        repoRoots: ["/repo"],
        startedAt: "2026-03-22T00:20:00.000Z",
        modifiedAt: "2026-03-22T00:30:00.000Z",
        messageCount: 1,
        entryCount: 1,
      },
      "full_reindex",
    );
    insertTextChunk(db, {
      sessionId: "session-1",
      entryId: "entry-1",
      entryType: "message",
      role: "user",
      ts: "2026-03-22T00:01:00.000Z",
      sourceKind: "user_text",
      text: "navigation anchor alpha",
    });
    insertTextChunk(db, {
      sessionId: "session-2",
      entryId: "entry-2",
      entryType: "message",
      role: "user",
      ts: "2026-03-22T00:21:00.000Z",
      sourceKind: "user_text",
      text: "navigation anchor alpha",
    });

    const hits = searchSessionChunks(db, {
      sessionIds: ["session-1"],
      query: "navigation alpha",
      limit: 10,
    });
    db.close();

    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      sessionId: "session-1",
      entryId: "entry-1",
      sourceKind: "user_text",
      ts: "2026-03-22T00:01:00.000Z",
    });
  });

  it("backfills text searches with relaxed adjacent-term matches", () => {
    const dir = testFs.createTempDir();
    const dbPath = path.join(dir, "index.sqlite");

    const db = openIndexDatabase(dbPath, { create: true });
    initializeSchema(db);
    for (const sessionId of ["strict-session", "partial-session", "excluded-session"]) {
      insertSession(
        db,
        {
          sessionId,
          sessionPath: `/tmp/${sessionId}.jsonl`,
          sessionName: sessionId,
          cwd: "/repo/app",
          repoRoots: ["/repo"],
          startedAt: "2026-03-22T00:00:00.000Z",
          modifiedAt: "2026-03-22T00:10:00.000Z",
          messageCount: 1,
          entryCount: 1,
        },
        "full_reindex",
      );
    }
    insertTextChunk(db, {
      sessionId: "strict-session",
      entryId: "strict-entry",
      entryType: "message",
      role: "user",
      ts: "2026-03-22T00:01:00.000Z",
      sourceKind: "user_text",
      text: "alpha beta gamma",
    });
    insertTextChunk(db, {
      sessionId: "partial-session",
      entryId: "partial-entry",
      entryType: "message",
      role: "user",
      ts: "2026-03-22T00:02:00.000Z",
      sourceKind: "user_text",
      text: "alpha beta",
    });
    insertTextChunk(db, {
      sessionId: "excluded-session",
      entryId: "excluded-entry",
      entryType: "message",
      role: "user",
      ts: "2026-03-22T00:03:00.000Z",
      sourceKind: "user_text",
      text: "alpha beta forbidden",
    });

    const relaxedHits = searchSessionChunks(db, {
      query: "alpha beta gamma -forbidden",
      limit: 10,
    });
    const explicitHits = searchSessionChunks(db, {
      query: "alpha AND beta AND gamma",
      limit: 10,
    });
    const sessionHits = searchSessions(db, {
      query: "alpha beta gamma -forbidden",
      limit: 10,
    });

    expect(relaxedHits.map((hit) => hit.entryId)).toEqual(["strict-entry", "partial-entry"]);
    expect(explicitHits.map((hit) => hit.entryId)).toEqual(["strict-entry"]);
    expect(sessionHits.map((hit) => hit.sessionId)).toEqual(["strict-session", "partial-session"]);
    for (let i = 0; i < 300; i++) {
      insertTextChunk(db, {
        sessionId: "strict-session",
        entryId: `flood-${i}`,
        entryType: "message",
        ts: "2026-03-22T00:01:00.000Z",
        sourceKind: "user_text",
        text: "alpha beta gamma",
      });
    }
    expect(
      searchSessions(db, { query: "alpha beta gamma -forbidden", limit: 10 }).map(
        (hit) => hit.sessionId,
      ),
    ).toEqual(["strict-session", "partial-session"]);
    expect(searchSessions(db, { query: "alpha AND beta AND gamma", limit: 10 })).toHaveLength(1);
    db.close();
  });

  it("filters changed files separately from touched files", () => {
    const dir = testFs.createTempDir();
    const dbPath = path.join(dir, "index.sqlite");

    const db = openIndexDatabase(dbPath, { create: true });
    initializeSchema(db);
    insertSession(
      db,
      {
        sessionId: "read-session",
        sessionPath: "/tmp/read.jsonl",
        sessionName: "Read",
        cwd: "/repo/app",
        repoRoots: ["/repo"],
        startedAt: "2026-03-22T00:00:00.000Z",
        modifiedAt: "2026-03-22T00:05:00.000Z",
        messageCount: 1,
        entryCount: 1,
      },
      "full_reindex",
    );
    insertSessionFileTouch(db, {
      sessionId: "read-session",
      entryId: "read-entry",
      op: "read",
      source: "tool_call",
      rawPath: "src/search.ts",
      absPath: "/repo/app/src/search.ts",
      cwdRelPath: "src/search.ts",
      repoRoot: "/repo",
      repoRelPath: "app/src/search.ts",
      basename: "search.ts",
      pathScope: "relative",
      ts: "2026-03-22T00:01:00.000Z",
    });
    insertSession(
      db,
      {
        sessionId: "changed-session",
        sessionPath: "/tmp/changed.jsonl",
        sessionName: "Changed",
        cwd: "/repo/app",
        repoRoots: ["/repo"],
        startedAt: "2026-03-22T00:10:00.000Z",
        modifiedAt: "2026-03-22T00:15:00.000Z",
        messageCount: 1,
        entryCount: 1,
      },
      "full_reindex",
    );
    insertSessionFileTouch(db, {
      sessionId: "changed-session",
      entryId: "changed-entry",
      op: "changed",
      source: "tool_call",
      rawPath: "src/search.ts",
      absPath: "/repo/app/src/search.ts",
      cwdRelPath: "src/search.ts",
      repoRoot: "/repo",
      repoRelPath: "app/src/search.ts",
      basename: "search.ts",
      pathScope: "relative",
      ts: "2026-03-22T00:11:00.000Z",
    });
    db.close();

    const searchDb = openIndexDatabase(dbPath, { create: false });
    const touchedHits = searchSessions(searchDb, { touched: ["src/search.ts"], limit: 10 });
    const changedHits = searchSessions(searchDb, { changed: ["src/search.ts"], limit: 10 });
    searchDb.close();

    expect(touchedHits.map((result) => result.sessionId)).toEqual([
      "changed-session",
      "read-session",
    ]);
    expect(changedHits.map((result) => result.sessionId)).toEqual(["changed-session"]);
    expect(changedHits[0]?.evidence).toEqual([
      {
        kind: "file_touch",
        op: "changed",
        query: "src/search.ts",
        path: "app/src/search.ts",
        entryId: "changed-entry",
      },
    ]);
  });

  it("uses session time overlap for after/before filtering", () => {
    const dir = testFs.createTempDir();
    const dbPath = path.join(dir, "index.sqlite");

    const db = openIndexDatabase(dbPath, { create: true });
    initializeSchema(db);
    insertSession(
      db,
      {
        sessionId: "session-overlap",
        sessionPath: "/tmp/session-overlap.jsonl",
        sessionName: "Overlap",
        cwd: "/repo/app",
        repoRoots: ["/repo"],
        startedAt: "2026-03-22T00:00:00.000Z",
        modifiedAt: "2026-03-22T00:10:00.000Z",
        messageCount: 2,
        entryCount: 3,
      },
      "full_reindex",
    );
    insertSession(
      db,
      {
        sessionId: "session-boundary",
        sessionPath: "/tmp/session-boundary.jsonl",
        sessionName: "Boundary",
        cwd: "/repo/app",
        repoRoots: ["/repo"],
        startedAt: "2026-03-22T00:07:00.000Z",
        modifiedAt: "2026-03-22T00:12:00.000Z",
        messageCount: 2,
        entryCount: 3,
      },
      "full_reindex",
    );
    insertSession(
      db,
      {
        sessionId: "session-late",
        sessionPath: "/tmp/session-late.jsonl",
        sessionName: "Late",
        cwd: "/repo/app",
        repoRoots: ["/repo"],
        startedAt: "2026-03-22T00:20:00.000Z",
        modifiedAt: "2026-03-22T00:30:00.000Z",
        messageCount: 2,
        entryCount: 3,
      },
      "full_reindex",
    );
    db.close();

    const searchDb = openIndexDatabase(dbPath, { create: false });
    const overlappingHits = searchSessions(searchDb, {
      after: "2026-03-22T00:05:00.000Z",
      before: "2026-03-22T00:07:00.000Z",
      limit: 10,
    });
    const afterOnlyHits = searchSessions(searchDb, {
      after: "2026-03-22T00:11:00.000Z",
      limit: 10,
    });
    const beforeOnlyHits = searchSessions(searchDb, {
      before: "2026-03-22T00:00:00.000Z",
      limit: 10,
    });
    searchDb.close();

    expect(overlappingHits.map((result) => result.sessionId)).toEqual([
      "session-boundary",
      "session-overlap",
    ]);
    expect(afterOnlyHits.map((result) => result.sessionId)).toEqual([
      "session-late",
      "session-boundary",
    ]);
    expect(beforeOnlyHits.map((result) => result.sessionId)).toEqual(["session-overlap"]);
  });

  it("ranks UUID matches first and deduplicates canonical plus compact session-id evidence", () => {
    const dir = testFs.createTempDir();
    const dbPath = path.join(dir, "index.sqlite");
    const targetId = "2dc89501-5e75-4c75-bc71-15c499d850b2";
    const compactTargetId = targetId.replace(/-/g, "");

    const db = openIndexDatabase(dbPath, { create: true });
    initializeSchema(db);
    insertSession(
      db,
      {
        sessionId: targetId,
        sessionPath: "/tmp/target.jsonl",
        sessionName: "Target session",
        cwd: "/repo/app",
        repoRoots: ["/repo"],
        startedAt: "2026-03-22T00:00:00.000Z",
        modifiedAt: "2026-03-22T00:10:00.000Z",
        messageCount: 3,
        entryCount: 4,
      },
      "full_reindex",
    );
    insertTextChunk(db, {
      sessionId: targetId,
      entryId: "entry-target",
      entryType: "message",
      role: "assistant",
      ts: "2026-03-22T00:05:00.000Z",
      sourceKind: "assistant_text",
      text: "autocomplete parser work",
    });
    insertSession(
      db,
      {
        sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        sessionPath: "/tmp/other.jsonl",
        sessionName: "Other session",
        cwd: "/repo/app",
        repoRoots: ["/repo"],
        startedAt: "2026-03-22T00:20:00.000Z",
        modifiedAt: "2026-03-22T00:30:00.000Z",
        messageCount: 3,
        entryCount: 4,
      },
      "full_reindex",
    );
    insertTextChunk(db, {
      sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      entryId: "entry-other",
      entryType: "message",
      role: "assistant",
      ts: "2026-03-22T00:25:00.000Z",
      sourceKind: "assistant_text",
      text: "autocomplete parser work",
    });
    db.close();

    const searchDb = openIndexDatabase(dbPath, { create: false });
    const compactHits = searchSessions(searchDb, {
      query: compactTargetId,
      limit: 10,
    });
    const canonicalHits = searchSessions(searchDb, {
      query: targetId,
      limit: 10,
    });
    expect(searchSessions(searchDb, { query: `${targetId} -parser`, limit: 10 })).toEqual([]);
    searchDb.close();

    expect(compactHits[0]?.sessionId).toBe(targetId);
    expect(compactHits[0]?.hitCount).toBe(1);
    expect(canonicalHits[0]?.sessionId).toBe(targetId);
    expect(canonicalHits[0]?.hitCount).toBe(1);
  });

  it("supports boolean expressions, exact quotes, prefix terms, and session-level negation", () => {
    const dir = testFs.createTempDir();
    const dbPath = path.join(dir, "index.sqlite");

    const db = openIndexDatabase(dbPath, { create: true });
    initializeSchema(db);
    insertSession(
      db,
      {
        sessionId: "excluded-session",
        sessionPath: "/tmp/excluded.jsonl",
        sessionName: "Excluded",
        cwd: "/repo/app",
        repoRoots: ["/repo"],
        startedAt: "2026-03-22T00:00:00.000Z",
        modifiedAt: "2026-03-22T00:05:00.000Z",
        messageCount: 1,
        entryCount: 1,
      },
      "full_reindex",
    );
    insertTextChunk(db, {
      sessionId: "excluded-session",
      entryId: "excluded-entry",
      entryType: "message",
      role: "assistant",
      ts: "2026-03-22T00:01:00.000Z",
      sourceKind: "assistant_text",
      text: "sqlite ranking bm25 schema",
    });
    insertSession(
      db,
      {
        sessionId: "included-session",
        sessionPath: "/tmp/included.jsonl",
        sessionName: "Included",
        cwd: "/repo/app",
        repoRoots: ["/repo"],
        startedAt: "2026-03-22T00:10:00.000Z",
        modifiedAt: "2026-03-22T00:15:00.000Z",
        messageCount: 1,
        entryCount: 1,
      },
      "full_reindex",
    );
    insertTextChunk(db, {
      sessionId: "included-session",
      entryId: "included-entry",
      entryType: "message",
      role: "assistant",
      ts: "2026-03-22T00:11:00.000Z",
      sourceKind: "assistant_text",
      text: "sqlite ranking bm25",
    });
    insertSession(
      db,
      {
        sessionId: "phrase-session",
        sessionPath: "/tmp/phrase.jsonl",
        sessionName: "Phrase",
        cwd: "/repo/app",
        repoRoots: ["/repo"],
        startedAt: "2026-03-22T00:20:00.000Z",
        modifiedAt: "2026-03-22T00:25:00.000Z",
        messageCount: 1,
        entryCount: 1,
      },
      "full_reindex",
    );
    insertTextChunk(db, {
      sessionId: "phrase-session",
      entryId: "phrase-entry",
      entryType: "message",
      role: "assistant",
      ts: "2026-03-22T00:21:00.000Z",
      sourceKind: "assistant_text",
      text: "session search sqlite3",
    });
    insertSession(
      db,
      {
        sessionId: "scattered-session",
        sessionPath: "/tmp/scattered.jsonl",
        sessionName: "Scattered",
        cwd: "/repo/app",
        repoRoots: ["/repo"],
        startedAt: "2026-03-22T00:30:00.000Z",
        modifiedAt: "2026-03-22T00:35:00.000Z",
        messageCount: 1,
        entryCount: 1,
      },
      "full_reindex",
    );
    insertTextChunk(db, {
      sessionId: "scattered-session",
      entryId: "scattered-entry",
      entryType: "message",
      role: "assistant",
      ts: "2026-03-22T00:31:00.000Z",
      sourceKind: "assistant_text",
      text: "session with search sqlite",
    });
    db.close();

    const searchDb = openIndexDatabase(dbPath, { create: false });
    const negatedHits = searchSessions(searchDb, {
      query: "sqlite AND (ranking OR bm25) -schema",
      limit: 10,
    });
    const phraseHits = searchSessions(searchDb, { query: '"session search"', limit: 10 });
    const prefixHits = searchSessions(searchDb, { query: "sqlite", limit: 10 });
    const exactHits = searchSessions(searchDb, { query: '"sqlite"', limit: 10 });
    searchDb.close();

    expect(negatedHits.map((result) => result.sessionId)).toEqual(["included-session"]);
    expect(phraseHits.map((result) => result.sessionId)).toEqual(["phrase-session"]);
    expect(prefixHits.map((result) => result.sessionId)).toContain("phrase-session");
    expect(exactHits.map((result) => result.sessionId)).not.toContain("phrase-session");
    expect(exactHits.map((result) => result.sessionId)).toContain("scattered-session");
  });

  it("rejects invalid time filters and negative-only queries in the shared layer", () => {
    const dir = testFs.createTempDir();
    const dbPath = path.join(dir, "index.sqlite");

    const db = openIndexDatabase(dbPath, { create: true });
    initializeSchema(db);

    expect(() => searchSessions(db, { after: "not-a-date" })).toThrow("Invalid time filter");
    expect(() => searchSessions(db, { after: "2026-03-23", before: "2026-03-22" })).toThrow(
      "time.after must be less than or equal to time.before",
    );
    expect(() => searchSessions(db, { query: "-schema" })).toThrow("Negative-only searches");

    db.close();
  });

  it("uses modified sort as display ordering after relevance selection", () => {
    const dir = testFs.createTempDir();
    const dbPath = path.join(dir, "index.sqlite");

    const db = openIndexDatabase(dbPath, { create: true });
    initializeSchema(db);
    insertSession(
      db,
      {
        sessionId: "older-strong",
        sessionPath: "/tmp/older-strong.jsonl",
        sessionName: "Older strong",
        cwd: "/repo/app",
        repoRoots: ["/repo"],
        startedAt: "2026-03-20T00:00:00.000Z",
        modifiedAt: "2026-03-20T00:05:00.000Z",
        messageCount: 1,
        entryCount: 1,
      },
      "full_reindex",
    );
    insertTextChunk(db, {
      sessionId: "older-strong",
      entryId: "older-strong-entry",
      entryType: "message",
      role: "assistant",
      ts: "2026-03-20T00:01:00.000Z",
      sourceKind: "session_name",
      text: "selector ranking",
    });
    insertSession(
      db,
      {
        sessionId: "newer-strong",
        sessionPath: "/tmp/newer-strong.jsonl",
        sessionName: "Newer strong",
        cwd: "/repo/app",
        repoRoots: ["/repo"],
        startedAt: "2026-03-22T00:00:00.000Z",
        modifiedAt: "2026-03-22T00:05:00.000Z",
        messageCount: 1,
        entryCount: 1,
      },
      "full_reindex",
    );
    insertTextChunk(db, {
      sessionId: "newer-strong",
      entryId: "newer-strong-entry",
      entryType: "message",
      role: "assistant",
      ts: "2026-03-22T00:01:00.000Z",
      sourceKind: "assistant_text",
      text: "selector ranking",
    });
    insertSession(
      db,
      {
        sessionId: "newest-weak",
        sessionPath: "/tmp/newest-weak.jsonl",
        sessionName: "Newest weak",
        cwd: "/repo/app",
        repoRoots: ["/repo"],
        startedAt: "2026-03-23T00:00:00.000Z",
        modifiedAt: "2026-03-23T00:05:00.000Z",
        messageCount: 1,
        entryCount: 1,
      },
      "full_reindex",
    );
    insertTextChunk(db, {
      sessionId: "newest-weak",
      entryId: "newest-weak-entry",
      entryType: "message",
      role: "assistant",
      ts: "2026-03-23T00:01:00.000Z",
      sourceKind: "assistant_text",
      text: "selector",
    });
    db.close();

    const searchDb = openIndexDatabase(dbPath, { create: false });
    const relevanceHits = searchSessions(searchDb, { query: "selector ranking", limit: 2 });
    const modifiedAscHits = searchSessions(searchDb, {
      query: "selector ranking",
      sort: "modified_asc",
      limit: 2,
    });
    searchDb.close();

    expect(relevanceHits.map((result) => result.sessionId)).not.toContain("newest-weak");
    expect(modifiedAscHits.map((result) => result.sessionId)).toEqual(
      [...relevanceHits]
        .sort((a, b) => a.modifiedAt.localeCompare(b.modifiedAt))
        .map((result) => result.sessionId),
    );
  });

  it("weights recency strongly for non-UUID search results", () => {
    const dir = testFs.createTempDir();
    const dbPath = path.join(dir, "index.sqlite");

    const db = openIndexDatabase(dbPath, { create: true });
    initializeSchema(db);
    insertSession(
      db,
      {
        sessionId: "older-session",
        sessionPath: "/tmp/older.jsonl",
        sessionName: "Older",
        cwd: "/repo/app",
        repoRoots: ["/repo"],
        startedAt: "2026-03-22T00:00:00.000Z",
        modifiedAt: "2026-03-22T00:10:00.000Z",
        messageCount: 2,
        entryCount: 3,
      },
      "full_reindex",
    );
    insertTextChunk(db, {
      sessionId: "older-session",
      entryId: "entry-older",
      entryType: "message",
      role: "assistant",
      ts: "2026-03-22T00:05:00.000Z",
      sourceKind: "assistant_text",
      text: "autocomplete parser",
    });
    insertSession(
      db,
      {
        sessionId: "newer-session",
        sessionPath: "/tmp/newer.jsonl",
        sessionName: "Newer",
        cwd: "/repo/app",
        repoRoots: ["/repo"],
        startedAt: "2026-03-22T00:20:00.000Z",
        modifiedAt: "2026-03-22T00:30:00.000Z",
        messageCount: 2,
        entryCount: 3,
      },
      "full_reindex",
    );
    insertTextChunk(db, {
      sessionId: "newer-session",
      entryId: "entry-newer",
      entryType: "message",
      role: "assistant",
      ts: "2026-03-22T00:25:00.000Z",
      sourceKind: "assistant_text",
      text: "autocomplete parser",
    });
    db.close();

    const searchDb = openIndexDatabase(dbPath, { create: false });
    const hits = searchSessions(searchDb, { query: "autocomplete parser", limit: 10 });
    searchDb.close();

    expect(hits.map((result) => result.sessionId)).toEqual(["newer-session", "older-session"]);
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
      .prepare(
        `SELECT COUNT(*) as count FROM session_text_chunks_fts WHERE session_text_chunks_fts MATCH 'before OR session'`,
      )
      .get() as { count: number };
    const schemaVersion = getMetadata(db, "schema_version");
    db.close();

    expect(chunkCount.count).toBe(0);
    expect(touchCount.count).toBe(0);
    expect(ftsCount.count).toBe(0);
    expect(schemaVersion).toBe(String(INDEX_SCHEMA_VERSION));
  });
});
