import { createRequire } from "node:module";

const requireModule = createRequire(import.meta.url);
const isBun = Boolean(process.versions.bun);

const DEFAULT_BUSY_TIMEOUT_MS = 5000;

export type SqliteBindValue = string | number | bigint | null;

export interface SqliteRunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface SqliteStatement {
  get(...params: SqliteBindValue[]): unknown;
  all(...params: SqliteBindValue[]): unknown[];
  run(...params: SqliteBindValue[]): SqliteRunResult;
}

export interface SqliteTransaction<Args extends unknown[], Result> {
  (...args: Args): Result;
  immediate(...args: Args): Result;
}

export interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  transaction<Args extends unknown[], Result>(
    fn: (...args: Args) => Result,
  ): SqliteTransaction<Args, Result>;
  close(): void;
}

interface SqliteConstructor {
  new (path: string, options?: Record<string, unknown>): SqliteDatabase;
}

// The driver is resolved at runtime so Bun never loads the native better-sqlite3
// addon (unsupported) and Node never loads the bun:sqlite builtin. The require
// result is untyped, so the cast to our structural contract is unavoidable here.
function loadDatabaseConstructor(): SqliteConstructor {
  if (isBun) {
    return (requireModule("bun:sqlite") as { Database: SqliteConstructor }).Database;
  }
  return requireModule("better-sqlite3") as SqliteConstructor;
}

export function openSqlite(
  dbPath: string,
  options: { create: boolean; readonly?: boolean | undefined; timeoutMs?: number | undefined },
): SqliteDatabase {
  const Database = loadDatabaseConstructor();
  const readonly = options.readonly ?? false;
  const db = isBun
    ? new Database(dbPath, {
        create: readonly ? false : options.create,
        readonly,
        readwrite: !readonly,
      })
    : new Database(dbPath, { fileMustExist: readonly || !options.create, readonly });

  db.exec(`PRAGMA busy_timeout = ${options.timeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS}`);
  db.exec("PRAGMA foreign_keys = ON");

  if (!readonly) {
    // journal_mode is the connection's first write-capable lock acquisition (and
    // may run WAL recovery), and immediate transactions rely on busy_timeout to
    // queue behind concurrent writers instead of failing.
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = NORMAL");
  }

  return withStatementCache(db);
}

// Neither driver memoizes prepare(), and the write paths prepare the same
// statements once per row. SQLite re-prepares cached statements transparently
// when the schema changes, so reusing them across DDL is safe.
function withStatementCache(db: SqliteDatabase): SqliteDatabase {
  const statements = new Map<string, SqliteStatement>();

  return {
    prepare(sql) {
      const cached = statements.get(sql);
      if (cached) {
        return cached;
      }

      const statement = db.prepare(sql);
      statements.set(sql, statement);
      return statement;
    },
    exec(sql) {
      db.exec(sql);
    },
    transaction(fn) {
      return db.transaction(fn);
    },
    close() {
      statements.clear();
      db.close();
    },
  };
}
