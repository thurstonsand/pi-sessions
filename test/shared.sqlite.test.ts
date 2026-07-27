import { existsSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openSqlite } from "../extensions/shared/session-index/sqlite.ts";
import { createTestFilesystem } from "./test-helpers.ts";

const testFs = createTestFilesystem("pi-sessions-sqlite-");

afterEach(() => {
  testFs.cleanup();
});

function openCounterDb(): { dbPath: string; db: ReturnType<typeof openSqlite> } {
  const dbPath = path.join(testFs.createTempDir(), "index.sqlite");
  const db = openSqlite(dbPath, { create: true });
  db.exec("CREATE TABLE t (a INTEGER)");
  return { dbPath, db };
}

function rowCount(db: ReturnType<typeof openSqlite>): number {
  return (db.prepare("SELECT count(*) AS n FROM t").get() as { n: number }).n;
}

describe("openSqlite", () => {
  it("refuses to open a missing database instead of creating one", () => {
    const dbPath = path.join(testFs.createTempDir(), "absent.sqlite");

    expect(() => openSqlite(dbPath, { create: false })).toThrow(/does not exist/);
    expect(existsSync(dbPath)).toBe(false);
  });
});

describe("openSqlite transactions", () => {
  it("commits the callback's writes and returns its result", () => {
    const { db } = openCounterDb();

    const result = db.transaction(() => {
      db.prepare("INSERT INTO t (a) VALUES (?)").run(1);
      db.prepare("INSERT INTO t (a) VALUES (?)").run(2);
      return "done";
    });

    expect(result).toBe("done");
    expect(rowCount(db)).toBe(2);
    db.close();
  });

  it("rolls back every write when the callback throws", () => {
    const { db } = openCounterDb();
    const failure = new Error("callback exploded");

    expect(() =>
      db.transaction(() => {
        db.prepare("INSERT INTO t (a) VALUES (?)").run(1);
        throw failure;
      }),
    ).toThrow(failure);

    expect(rowCount(db)).toBe(0);
    db.close();
  });

  it("refuses to nest and leaves the connection usable", () => {
    const { db } = openCounterDb();

    expect(() =>
      db.transaction(() => {
        db.prepare("INSERT INTO t (a) VALUES (?)").run(1);
        db.transaction(() => undefined);
      }),
    ).toThrow(/Cannot nest transactions/);

    expect(rowCount(db)).toBe(0);

    db.transaction(() => {
      db.prepare("INSERT INTO t (a) VALUES (?)").run(2);
    });
    expect(rowCount(db)).toBe(1);
    db.close();
  });

  // A deferred transaction that has only read so far holds no write lock, so
  // the second connection would succeed here and the stale snapshot would fail
  // on our own upgrade instead.
  it("holds the write lock from BEGIN, before the callback's first write", () => {
    const { dbPath, db } = openCounterDb();
    const other = openSqlite(dbPath, { create: false, timeoutMs: 50 });

    db.transaction(() => {
      expect(db.prepare("SELECT count(*) AS n FROM t").get()).toEqual({ n: 0 });
      expect(() => other.prepare("INSERT INTO t (a) VALUES (?)").run(9)).toThrow();
    });

    expect(rowCount(db)).toBe(0);
    other.close();
    db.close();
  });
});
