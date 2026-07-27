import { existsSync } from "node:fs";
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

// The surface this module consumes from a native driver. Transactions are
// implemented inline
interface SqliteDriver {
  prepare(sql: string): SqliteStatement;
  exec(sql: string): void;
  close(): void;
}

export interface SqliteDatabase extends SqliteDriver {
  transaction<Result>(fn: () => Result): Result;
}

interface SqliteConstructor {
  new (path: string, options?: Record<string, unknown>): SqliteDriver;
}

// Each runtime gets its own built-in SQLite, resolved at runtime because neither
// module is importable from the other. The require result is untyped, so the
// cast to our structural contract is unavoidable here.
function loadDatabaseConstructor(): SqliteConstructor {
  if (isBun) {
    return (requireModule("bun:sqlite") as { Database: SqliteConstructor }).Database;
  }
  return (requireModule("node:sqlite") as { DatabaseSync: SqliteConstructor }).DatabaseSync;
}

export function openSqlite(
  dbPath: string,
  options: { create: boolean; readonly?: boolean | undefined; timeoutMs?: number | undefined },
): SqliteDatabase {
  const Database = loadDatabaseConstructor();
  const readonly = options.readonly ?? false;

  // node:sqlite has no fileMustExist equivalent and would otherwise create an
  // empty database where the caller demanded an existing one.
  if (!options.create && !existsSync(dbPath)) {
    throw new Error(`SQLite database does not exist: ${dbPath}`);
  }

  const db = isBun
    ? new Database(dbPath, {
        create: readonly ? false : options.create,
        readonly,
        readwrite: !readonly,
      })
    : new Database(dbPath, { readOnly: readonly });

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
function withStatementCache(db: SqliteDriver): SqliteDatabase {
  const statements = new Map<string, SqliteStatement>();
  let inTransaction = false;

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
    // Immediate rather than deferred: these callbacks read before they write, and
    // a deferred transaction's read-to-write upgrade fails SQLITE_BUSY outright
    // instead of waiting on busy_timeout.
    transaction(fn) {
      if (inTransaction) {
        throw new Error(
          "Cannot nest transactions: the outer BEGIN IMMEDIATE already holds the write lock",
        );
      }

      inTransaction = true;
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = fn();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      } finally {
        inTransaction = false;
      }
    },
    close() {
      statements.clear();
      db.close();
    },
  };
}
