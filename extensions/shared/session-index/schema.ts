import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { parseTypeBoxValue } from "../typebox.js";
import {
  INDEX_SCHEMA_VERSION,
  METADATA_ROW_SCHEMA,
  ROW_COUNT_SCHEMA,
  type SessionIndexDatabase,
  type SessionIndexStatus,
} from "./common.js";

export function ensureIndexDir(dir: string): string {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function createTempIndexPath(finalPath: string): string {
  const dir = path.dirname(finalPath);
  const baseName = path.basename(finalPath, path.extname(finalPath));
  ensureIndexDir(dir);
  return path.join(dir, `${baseName}.tmp-${process.pid}-${Date.now()}.sqlite`);
}

export function openIndexDatabase(
  dbPath: string,
  options?: { create?: boolean; timeoutMs?: number },
): SessionIndexDatabase {
  const create = options?.create ?? true;
  const db = new Database(
    dbPath,
    options?.timeoutMs === undefined
      ? { fileMustExist: !create }
      : { fileMustExist: !create, timeout: options.timeoutMs },
  );
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  return db;
}

export function initializeSchema(db: SessionIndexDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      session_id TEXT PRIMARY KEY,
      session_path TEXT NOT NULL,
      session_name TEXT NOT NULL,
      first_user_prompt TEXT,
      cwd TEXT NOT NULL,
      repo_roots_json TEXT NOT NULL,
      created_ts TEXT NOT NULL,
      modified_ts TEXT NOT NULL,
      message_count INTEGER NOT NULL,
      entry_count INTEGER NOT NULL,
      parent_session_path TEXT,
      parent_session_id TEXT,
      session_origin TEXT,
      handoff_goal TEXT,
      handoff_next_task TEXT,
      index_version INTEGER NOT NULL,
      indexed_at_ts TEXT NOT NULL,
      index_source TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS sessions_modified_idx ON sessions(modified_ts DESC);
    CREATE INDEX IF NOT EXISTS sessions_cwd_idx ON sessions(cwd);
    CREATE INDEX IF NOT EXISTS sessions_path_idx ON sessions(session_path);
    CREATE INDEX IF NOT EXISTS sessions_parent_id_idx ON sessions(parent_session_id);
    CREATE INDEX IF NOT EXISTS sessions_parent_path_idx ON sessions(parent_session_path);

    CREATE TABLE IF NOT EXISTS session_lineage_relations (
      session_id TEXT NOT NULL,
      related_session_id TEXT NOT NULL,
      relation TEXT NOT NULL,
      distance INTEGER NOT NULL,
      PRIMARY KEY (session_id, related_session_id),
      FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE,
      FOREIGN KEY (related_session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS session_lineage_relations_related_idx
      ON session_lineage_relations(related_session_id);
    CREATE INDEX IF NOT EXISTS session_lineage_relations_relation_idx
      ON session_lineage_relations(session_id, relation, distance);

    CREATE TABLE IF NOT EXISTS session_text_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      entry_id TEXT,
      entry_type TEXT NOT NULL,
      role TEXT,
      ts TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      text TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS session_text_chunks_session_idx ON session_text_chunks(session_id);
    CREATE INDEX IF NOT EXISTS session_text_chunks_ts_idx ON session_text_chunks(ts DESC);

    CREATE VIRTUAL TABLE IF NOT EXISTS session_text_chunks_fts USING fts5(
      chunk_id UNINDEXED,
      session_id UNINDEXED,
      text
    );

    CREATE TABLE IF NOT EXISTS session_file_touches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      entry_id TEXT,
      op TEXT NOT NULL,
      source TEXT NOT NULL,
      raw_path TEXT NOT NULL,
      abs_path TEXT,
      cwd_rel_path TEXT,
      repo_root TEXT,
      repo_rel_path TEXT,
      basename TEXT NOT NULL,
      path_scope TEXT NOT NULL,
      ts TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS session_file_touches_session_idx ON session_file_touches(session_id);
    CREATE INDEX IF NOT EXISTS session_file_touches_op_idx ON session_file_touches(op);
    CREATE INDEX IF NOT EXISTS session_file_touches_abs_idx ON session_file_touches(abs_path);
    CREATE INDEX IF NOT EXISTS session_file_touches_repo_root_idx ON session_file_touches(repo_root);
    CREATE INDEX IF NOT EXISTS session_file_touches_repo_rel_idx ON session_file_touches(repo_rel_path);
    CREATE INDEX IF NOT EXISTS session_file_touches_cwd_rel_idx ON session_file_touches(cwd_rel_path);
    CREATE INDEX IF NOT EXISTS session_file_touches_basename_idx ON session_file_touches(basename);
  `);

  setMetadata(db, "schema_version", String(INDEX_SCHEMA_VERSION));
}

export function setMetadata(db: SessionIndexDatabase, key: string, value: string): void {
  db.prepare(
    `INSERT INTO metadata(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

export function getMetadata(db: SessionIndexDatabase, key: string): string | undefined {
  const row = db.prepare(`SELECT value FROM metadata WHERE key = ?`).get(key);
  if (row === undefined) {
    return undefined;
  }

  return parseTypeBoxValue(METADATA_ROW_SCHEMA, row, `Invalid metadata row for key ${key}`).value;
}

export function getIndexStatus(dbPath: string): SessionIndexStatus {
  if (!existsSync(dbPath)) {
    return { dbPath, exists: false };
  }

  const db = openIndexDatabase(dbPath, { create: false });
  try {
    const schemaVersionRaw = getMetadata(db, "schema_version");
    const lastFullReindexAt = getMetadata(db, "indexed_at");
    const sessionCountRow = parseTypeBoxValue(
      ROW_COUNT_SCHEMA,
      db.prepare(`SELECT COUNT(*) as count FROM sessions`).get(),
      "Invalid session count row",
    );

    return {
      dbPath,
      exists: true,
      schemaVersion: schemaVersionRaw ? Number(schemaVersionRaw) : undefined,
      sessionCount: sessionCountRow.count,
      lastFullReindexAt,
    };
  } finally {
    db.close();
  }
}
