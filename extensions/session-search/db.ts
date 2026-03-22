import { existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

export const INDEX_SCHEMA_VERSION = 1;

const DEFAULT_SEARCH_LIMIT = 10;

export interface SessionRow {
  sessionId: string;
  sessionPath: string;
  sessionName: string;
  cwd: string;
  repoRoots: string[];
  startedAt: string;
  modifiedAt: string;
  messageCount: number;
  entryCount: number;
}

export interface SessionTextChunkRow {
  id?: number | undefined;
  sessionId: string;
  entryId?: string | undefined;
  entryType: string;
  role?: string | undefined;
  ts: string;
  sourceKind: string;
  text: string;
}

export interface SearchSessionsParams {
  query?: string | undefined;
  cwd?: string | undefined;
  after?: string | undefined;
  before?: string | undefined;
  limit?: number | undefined;
}

export interface SearchSessionResult {
  sessionId: string;
  sessionName: string;
  sessionPath: string;
  cwd: string;
  repoRoots: string[];
  startedAt: string;
  modifiedAt: string;
  snippet: string;
  score: number;
  hitCount: number;
}

export interface SessionIndexStatus {
  dbPath: string;
  exists: boolean;
  schemaVersion?: number | undefined;
  sessionCount?: number | undefined;
  lastFullReindexAt?: string | undefined;
}

export type SessionIndexDatabase = Database.Database;

interface SearchChunkRow {
  sessionId: string;
  sessionName: string;
  sessionPath: string;
  cwd: string;
  repoRootsJson: string;
  startedAt: string;
  modifiedAt: string;
  snippet: string;
  rank: number;
}

interface SessionListRow {
  sessionId: string;
  sessionName: string;
  sessionPath: string;
  cwd: string;
  repoRootsJson: string;
  startedAt: string;
  modifiedAt: string;
}

interface SearchFilters {
  after: string | undefined;
  before: string | undefined;
  cwd: string | undefined;
  cwdLike: string | undefined;
  limit: number;
  query: string | undefined;
}

export function getDefaultIndexDir(): string {
  return (
    process.env.PI_SESSIONS_INDEX_DIR ?? path.join(os.homedir(), ".pi", "agent", "pi-sessions")
  );
}

export function getDefaultIndexPath(): string {
  return path.join(getDefaultIndexDir(), "index.sqlite");
}

export function ensureIndexDir(dir: string = getDefaultIndexDir()): string {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

export function createTempIndexPath(finalPath: string = getDefaultIndexPath()): string {
  const dir = path.dirname(finalPath);
  const baseName = path.basename(finalPath, path.extname(finalPath));
  ensureIndexDir(dir);
  return path.join(dir, `${baseName}.tmp-${process.pid}-${Date.now()}.sqlite`);
}

export function openIndexDatabase(
  dbPath: string,
  options?: { create?: boolean },
): SessionIndexDatabase {
  const create = options?.create ?? true;
  const db = new Database(dbPath, { fileMustExist: !create });
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
      cwd TEXT NOT NULL,
      repo_roots_json TEXT NOT NULL,
      created_ts TEXT NOT NULL,
      modified_ts TEXT NOT NULL,
      message_count INTEGER NOT NULL,
      entry_count INTEGER NOT NULL,
      index_version INTEGER NOT NULL,
      indexed_at_ts TEXT NOT NULL,
      index_source TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS sessions_modified_idx ON sessions(modified_ts DESC);
    CREATE INDEX IF NOT EXISTS sessions_cwd_idx ON sessions(cwd);

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
  `);

  setMetadata(db, "schema_version", String(INDEX_SCHEMA_VERSION));
}

export function setMetadata(db: SessionIndexDatabase, key: string, value: string): void {
  db.prepare(
    `INSERT INTO metadata(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

export function getMetadata(db: SessionIndexDatabase, key: string): string | undefined {
  const row = db.prepare(`SELECT value FROM metadata WHERE key = ?`).get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

export function insertSession(
  db: SessionIndexDatabase,
  row: SessionRow,
  indexSource: string,
): void {
  const indexedAt = new Date().toISOString();
  db.prepare(
    `
      INSERT INTO sessions(
        session_id, session_path, session_name, cwd, repo_roots_json,
        created_ts, modified_ts, message_count, entry_count,
        index_version, indexed_at_ts, index_source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    row.sessionId,
    row.sessionPath,
    row.sessionName,
    row.cwd,
    JSON.stringify(row.repoRoots),
    row.startedAt,
    row.modifiedAt,
    row.messageCount,
    row.entryCount,
    INDEX_SCHEMA_VERSION,
    indexedAt,
    indexSource,
  );
}

export function insertTextChunk(db: SessionIndexDatabase, row: SessionTextChunkRow): void {
  const result = db
    .prepare(
      `
      INSERT INTO session_text_chunks(
        session_id, entry_id, entry_type, role, ts, source_kind, text
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
    )
    .run(
      row.sessionId,
      row.entryId ?? null,
      row.entryType,
      row.role ?? null,
      row.ts,
      row.sourceKind,
      row.text,
    );

  const chunkId = Number(result.lastInsertRowid);
  db.prepare(
    `INSERT INTO session_text_chunks_fts(chunk_id, session_id, text) VALUES (?, ?, ?)`,
  ).run(chunkId, row.sessionId, row.text);
}

export function getIndexStatus(dbPath: string = getDefaultIndexPath()): SessionIndexStatus {
  if (!existsSync(dbPath)) {
    return { dbPath, exists: false };
  }

  const db = openIndexDatabase(dbPath, { create: false });
  try {
    const schemaVersionRaw = getMetadata(db, "schema_version");
    const lastFullReindexAt = getMetadata(db, "indexed_at");
    const sessionCountRow = db.prepare(`SELECT COUNT(*) as count FROM sessions`).get() as {
      count: number;
    };

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

export function buildSearchSessionsQuery(
  db: SessionIndexDatabase,
  params: SearchSessionsParams,
): SearchSessionResult[] {
  const filters = buildSearchFilters(params);
  if (!filters.query) {
    return searchRecentSessions(db, filters);
  }

  const match = buildFtsQuery(filters.query);
  if (!match) {
    return [];
  }

  return searchTextMatches(db, filters, match);
}

function buildSearchFilters(params: SearchSessionsParams): SearchFilters {
  const cwd = params.cwd?.trim();

  return {
    after: normalizeTimeFilter(params.after),
    before: normalizeTimeFilter(params.before),
    cwd,
    cwdLike: cwd ? `${escapeLikePrefix(cwd)}%` : undefined,
    limit: params.limit ?? DEFAULT_SEARCH_LIMIT,
    query: params.query?.trim(),
  };
}

function searchRecentSessions(
  db: SessionIndexDatabase,
  filters: SearchFilters,
): SearchSessionResult[] {
  const rows = db
    .prepare(
      `
        SELECT
          session_id as sessionId,
          session_name as sessionName,
          session_path as sessionPath,
          cwd,
          repo_roots_json as repoRootsJson,
          created_ts as startedAt,
          modified_ts as modifiedAt
        FROM sessions
        WHERE (? IS NULL OR modified_ts >= ?)
          AND (? IS NULL OR modified_ts < ?)
          AND (? IS NULL OR cwd = ? OR cwd LIKE ? ESCAPE '\\')
        ORDER BY modified_ts DESC
        LIMIT ?
      `,
    )
    .all(...getSearchFilterBindings(filters), filters.limit) as SessionListRow[];

  return rows.map((row) => buildSearchResult(row, row.sessionName || row.cwd, 0, 0));
}

function searchTextMatches(
  db: SessionIndexDatabase,
  filters: SearchFilters,
  match: string,
): SearchSessionResult[] {
  const rows = db
    .prepare(
      `
      SELECT
        s.session_id as sessionId,
        s.session_name as sessionName,
        s.session_path as sessionPath,
        s.cwd as cwd,
        s.repo_roots_json as repoRootsJson,
        s.created_ts as startedAt,
        s.modified_ts as modifiedAt,
        snippet(session_text_chunks_fts, 2, '[', ']', ' … ', 12) as snippet,
        bm25(session_text_chunks_fts) as rank
      FROM session_text_chunks_fts
      JOIN session_text_chunks c ON c.id = CAST(session_text_chunks_fts.chunk_id AS INTEGER)
      JOIN sessions s ON s.session_id = c.session_id
      WHERE session_text_chunks_fts MATCH ?
        AND (? IS NULL OR s.modified_ts >= ?)
        AND (? IS NULL OR s.modified_ts < ?)
        AND (? IS NULL OR s.cwd = ? OR s.cwd LIKE ? ESCAPE '\\')
      ORDER BY rank ASC, s.modified_ts DESC
      LIMIT 500
    `,
    )
    .all(match, ...getSearchFilterBindings(filters)) as SearchChunkRow[];

  const aggregated = new Map<string, SearchSessionResult>();
  for (const row of rows) {
    const current = aggregated.get(row.sessionId);
    const chunkScore = Math.max(1, Number.isFinite(row.rank) ? -row.rank : 1);

    if (!current) {
      aggregated.set(row.sessionId, buildSearchResult(row, row.snippet, chunkScore, 1));
      continue;
    }

    current.hitCount += 1;
    current.score += chunkScore + 0.5;
  }

  return [...aggregated.values()]
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return b.modifiedAt.localeCompare(a.modifiedAt);
    })
    .slice(0, filters.limit);
}

function buildSearchResult(
  row: SessionListRow | SearchChunkRow,
  snippet: string,
  score: number,
  hitCount: number,
): SearchSessionResult {
  return {
    sessionId: row.sessionId,
    sessionName: row.sessionName,
    sessionPath: row.sessionPath,
    cwd: row.cwd,
    repoRoots: parseRepoRoots(row.repoRootsJson),
    startedAt: row.startedAt,
    modifiedAt: row.modifiedAt,
    snippet,
    score,
    hitCount,
  };
}

function getSearchFilterBindings(
  filters: SearchFilters,
): [
  string | null,
  string | null,
  string | null,
  string | null,
  string | null,
  string | null,
  string | null,
] {
  return [
    filters.after ?? null,
    filters.after ?? null,
    filters.before ?? null,
    filters.before ?? null,
    filters.cwd ?? null,
    filters.cwd ?? null,
    filters.cwdLike ?? null,
  ];
}

function escapeLikePrefix(value: string): string {
  return value.replace(/[%_]/g, "\\$&");
}

function normalizeTimeFilter(value?: string): string | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString();
}

function buildFtsQuery(query: string): string | undefined {
  const trimmed = query.trim();
  if (!trimmed) return undefined;

  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return quoteFtsToken(trimmed.slice(1, -1));
  }

  const tokens = trimmed.split(/\s+/).map(sanitizeFtsToken).filter(Boolean);

  if (tokens.length === 0) return undefined;
  return tokens.map(quoteFtsToken).join(" AND ");
}

function sanitizeFtsToken(token: string): string {
  return token.replace(/[(){}:[\]^~*]/g, " ").trim();
}

function quoteFtsToken(token: string): string {
  return `"${token.replace(/"/g, '""')}"`;
}

function parseRepoRoots(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === "string")) {
      return parsed;
    }
  } catch {
    // Ignore malformed JSON and fall back to empty list.
  }
  return [];
}
