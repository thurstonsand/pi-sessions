import { existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import {
  type FileTouchOp,
  type FileTouchSource,
  matchesRepoRoot,
  normalizeSearchPath,
  type PathScope,
} from "./normalize.js";

export const INDEX_SCHEMA_VERSION = 2;

const DEFAULT_SEARCH_LIMIT = 10;
const SEARCH_CANDIDATE_LIMIT = 2_000;
const TEXT_MATCH_ROW_LIMIT = 1_000;

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

export interface SessionFileTouchRow {
  id?: number | undefined;
  sessionId: string;
  entryId?: string | undefined;
  op: FileTouchOp;
  source: FileTouchSource;
  rawPath: string;
  absPath?: string | undefined;
  cwdRelPath?: string | undefined;
  repoRoot?: string | undefined;
  repoRelPath?: string | undefined;
  basename: string;
  pathScope: PathScope;
  ts: string;
}

export interface SearchSessionsParams {
  query?: string | undefined;
  cwd?: string | undefined;
  repo?: string | undefined;
  after?: string | undefined;
  before?: string | undefined;
  touched?: string[] | undefined;
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
  matchedFiles: string[];
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
  entryId?: string | undefined;
  sourceKind: string;
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

interface FileTouchMatchRow {
  sessionId: string;
  rawPath: string;
  absPath?: string | undefined;
  cwdRelPath?: string | undefined;
  repoRelPath?: string | undefined;
  basename: string;
  op: FileTouchOp;
}

interface SearchFilters {
  after: string | undefined;
  before: string | undefined;
  cwd: string | undefined;
  cwdLike: string | undefined;
  repo: string | undefined;
  touched: string[];
  limit: number;
  query: string | undefined;
}

interface FileMatchSummary {
  matchedFiles: string[];
  score: number;
  hitCount: number;
}

interface FileMatchAccumulator {
  matchedFiles: Set<string>;
  evidenceKeys: Set<string>;
  score: number;
}

interface FilePathMatch {
  displayPath: string;
  score: number;
}

interface SearchResultAccumulator {
  result: SearchSessionResult;
  evidenceKeys: Set<string>;
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
  const row = db.prepare(`SELECT value FROM metadata WHERE key = ?`).get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

function sessionRowBindings(
  row: SessionRow,
  indexSource: string,
): [
  string,
  string,
  string,
  string,
  string,
  string,
  string,
  number,
  number,
  number,
  string,
  string,
] {
  return [
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
    new Date().toISOString(),
    indexSource,
  ];
}

export function insertSession(
  db: SessionIndexDatabase,
  row: SessionRow,
  indexSource: string,
): void {
  db.prepare(
    `
      INSERT INTO sessions(
        session_id, session_path, session_name, cwd, repo_roots_json,
        created_ts, modified_ts, message_count, entry_count,
        index_version, indexed_at_ts, index_source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(...sessionRowBindings(row, indexSource));
}

export function upsertSession(
  db: SessionIndexDatabase,
  row: SessionRow,
  indexSource: string,
): void {
  db.prepare(
    `
      INSERT INTO sessions(
        session_id, session_path, session_name, cwd, repo_roots_json,
        created_ts, modified_ts, message_count, entry_count,
        index_version, indexed_at_ts, index_source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        session_path = excluded.session_path,
        session_name = excluded.session_name,
        cwd = excluded.cwd,
        repo_roots_json = excluded.repo_roots_json,
        created_ts = excluded.created_ts,
        modified_ts = excluded.modified_ts,
        message_count = excluded.message_count,
        entry_count = excluded.entry_count,
        index_version = excluded.index_version,
        indexed_at_ts = excluded.indexed_at_ts,
        index_source = excluded.index_source
    `,
  ).run(...sessionRowBindings(row, indexSource));
}

export function clearSessionIndexedData(db: SessionIndexDatabase, sessionId: string): void {
  db.prepare(`DELETE FROM session_text_chunks_fts WHERE session_id = ?`).run(sessionId);
  db.prepare(`DELETE FROM session_text_chunks WHERE session_id = ?`).run(sessionId);
  db.prepare(`DELETE FROM session_file_touches WHERE session_id = ?`).run(sessionId);
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

export function insertSessionFileTouch(db: SessionIndexDatabase, row: SessionFileTouchRow): void {
  db.prepare(
    `
      INSERT INTO session_file_touches(
        session_id, entry_id, op, source, raw_path, abs_path, cwd_rel_path,
        repo_root, repo_rel_path, basename, path_scope, ts
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    row.sessionId,
    row.entryId ?? null,
    row.op,
    row.source,
    row.rawPath,
    row.absPath ?? null,
    row.cwdRelPath ?? null,
    row.repoRoot ?? null,
    row.repoRelPath ?? null,
    row.basename,
    row.pathScope,
    row.ts,
  );
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
  const fileMatches = hasFileFilters(filters)
    ? collectFileMatches(getCandidateFileTouches(db, filters), filters)
    : new Map<string, FileMatchSummary>();

  const results = filters.query
    ? searchTextMatches(db, filters)
    : searchRecentSessions(db, filters);

  return finalizeSearchResults(results, fileMatches, filters);
}

function buildSearchFilters(params: SearchSessionsParams): SearchFilters {
  const cwd = params.cwd?.trim();

  return {
    after: normalizeTimeFilter(params.after),
    before: normalizeTimeFilter(params.before),
    cwd,
    cwdLike: cwd ? `${escapeLikePrefix(cwd)}%` : undefined,
    repo: params.repo?.trim(),
    touched: sanitizeFilterValues(params.touched),
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
    .all(...getSearchFilterBindings(filters), SEARCH_CANDIDATE_LIMIT) as SessionListRow[];

  return rows.map((row) => buildSearchResult(row, row.sessionName || row.cwd, 0, 0));
}

function searchTextMatches(
  db: SessionIndexDatabase,
  filters: SearchFilters,
): SearchSessionResult[] {
  const match = buildFtsQuery(filters.query ?? "");
  if (!match) {
    return [];
  }

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
        bm25(session_text_chunks_fts) as rank,
        c.entry_id as entryId,
        c.source_kind as sourceKind
      FROM session_text_chunks_fts
      JOIN session_text_chunks c ON c.id = CAST(session_text_chunks_fts.chunk_id AS INTEGER)
      JOIN sessions s ON s.session_id = c.session_id
      WHERE session_text_chunks_fts MATCH ?
        AND (? IS NULL OR s.modified_ts >= ?)
        AND (? IS NULL OR s.modified_ts < ?)
        AND (? IS NULL OR s.cwd = ? OR s.cwd LIKE ? ESCAPE '\\')
      ORDER BY rank ASC, s.modified_ts DESC
      LIMIT ?
    `,
    )
    .all(match, ...getSearchFilterBindings(filters), TEXT_MATCH_ROW_LIMIT) as SearchChunkRow[];

  const results = new Map<string, SearchResultAccumulator>();
  for (const row of rows) {
    const evidenceKey = row.entryId
      ? `${row.entryId}:${row.sourceKind}`
      : `${row.sourceKind}:${row.snippet}`;
    const baseScore = Math.max(1, Number.isFinite(row.rank) ? -row.rank : 1);
    const sourceBoost = row.sourceKind === "session_name" ? 1 : 0;
    const existing = results.get(row.sessionId);

    if (!existing) {
      const result = buildSearchResult(row, row.snippet, baseScore + sourceBoost, 1);
      results.set(row.sessionId, {
        result,
        evidenceKeys: new Set([evidenceKey]),
      });
      continue;
    }

    if (!existing.evidenceKeys.has(evidenceKey)) {
      existing.evidenceKeys.add(evidenceKey);
      existing.result.hitCount += 1;
      existing.result.score += baseScore + sourceBoost;
    }
  }

  return [...results.values()].map(({ result }) => ({
    ...result,
    score: result.score + boostIndependentHits(result.hitCount),
  }));
}

function getCandidateFileTouches(
  db: SessionIndexDatabase,
  filters: SearchFilters,
): FileTouchMatchRow[] {
  return db
    .prepare(
      `
        SELECT
          f.session_id as sessionId,
          f.raw_path as rawPath,
          f.abs_path as absPath,
          f.cwd_rel_path as cwdRelPath,
          f.repo_rel_path as repoRelPath,
          f.basename as basename,
          f.op as op
        FROM session_file_touches f
        JOIN sessions s ON s.session_id = f.session_id
        WHERE (? IS NULL OR s.modified_ts >= ?)
          AND (? IS NULL OR s.modified_ts < ?)
          AND (? IS NULL OR s.cwd = ? OR s.cwd LIKE ? ESCAPE '\\')
      `,
    )
    .all(...getSearchFilterBindings(filters)) as FileTouchMatchRow[];
}

function collectFileMatches(
  rows: FileTouchMatchRow[],
  filters: SearchFilters,
): Map<string, FileMatchSummary> {
  const accumulators = new Map<string, FileMatchAccumulator>();

  for (const query of filters.touched) {
    for (const row of rows) {
      if (!matchesTouchedFileOp(row.op)) {
        continue;
      }

      const fileMatch = matchFileTouch(row, query);
      if (!fileMatch) {
        continue;
      }

      const accumulator = getFileMatchAccumulator(accumulators, row.sessionId);
      const evidenceKey = `${normalizeSearchPath(query)}:${fileMatch.displayPath}`;
      if (accumulator.evidenceKeys.has(evidenceKey)) {
        continue;
      }

      accumulator.evidenceKeys.add(evidenceKey);
      accumulator.matchedFiles.add(fileMatch.displayPath);
      accumulator.score += fileMatch.score;
    }
  }

  return new Map(
    [...accumulators.entries()].map(([sessionId, accumulator]) => [
      sessionId,
      {
        matchedFiles: [...accumulator.matchedFiles].sort(),
        score: accumulator.score + boostIndependentHits(accumulator.evidenceKeys.size),
        hitCount: accumulator.evidenceKeys.size,
      },
    ]),
  );
}

function finalizeSearchResults(
  results: SearchSessionResult[],
  fileMatches: Map<string, FileMatchSummary>,
  filters: SearchFilters,
): SearchSessionResult[] {
  const finalized: SearchSessionResult[] = [];

  for (const result of results) {
    const repoQuery = filters.repo;
    if (repoQuery && !result.repoRoots.some((repoRoot) => matchesRepoRoot(repoRoot, repoQuery))) {
      continue;
    }

    const fileMatch = fileMatches.get(result.sessionId);
    if (hasFileFilters(filters) && !fileMatch) {
      continue;
    }

    const nextResult = {
      ...result,
      matchedFiles: fileMatch?.matchedFiles ?? [],
      score: result.score + (fileMatch?.score ?? 0),
      hitCount: result.hitCount + (fileMatch?.hitCount ?? 0),
    };

    if (result.hitCount > 0 && fileMatch) {
      nextResult.score += 2;
    }

    finalized.push(nextResult);
  }

  return finalized
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }

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
    matchedFiles: [],
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

function getFileMatchAccumulator(
  accumulators: Map<string, FileMatchAccumulator>,
  sessionId: string,
): FileMatchAccumulator {
  const existing = accumulators.get(sessionId);
  if (existing) {
    return existing;
  }

  const nextAccumulator: FileMatchAccumulator = {
    matchedFiles: new Set<string>(),
    evidenceKeys: new Set<string>(),
    score: 0,
  };
  accumulators.set(sessionId, nextAccumulator);
  return nextAccumulator;
}

function matchesTouchedFileOp(actualOp: FileTouchOp): boolean {
  return actualOp === "read" || actualOp === "changed";
}

function matchFileTouch(row: FileTouchMatchRow, rawQuery: string): FilePathMatch | undefined {
  const query = normalizeSearchPath(rawQuery);
  if (!query) {
    return undefined;
  }

  if (path.isAbsolute(query)) {
    return matchAbsolutePath(row, query);
  }

  if (query.includes("/")) {
    return matchRelativePath(row, query);
  }

  return row.basename === query
    ? {
        displayPath: row.repoRelPath ?? row.cwdRelPath ?? row.absPath ?? row.rawPath,
        score: 1,
      }
    : undefined;
}

function matchAbsolutePath(row: FileTouchMatchRow, query: string): FilePathMatch | undefined {
  if (!row.absPath) {
    return undefined;
  }

  if (row.absPath === query) {
    return { displayPath: row.absPath, score: 3 };
  }

  return row.absPath.endsWith(query) ? { displayPath: row.absPath, score: 2.5 } : undefined;
}

function matchRelativePath(row: FileTouchMatchRow, query: string): FilePathMatch | undefined {
  const candidates = [row.repoRelPath, row.cwdRelPath].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );

  for (const candidate of candidates) {
    if (candidate === query) {
      return { displayPath: candidate, score: 2.5 };
    }

    if (candidate.endsWith(`/${query}`)) {
      return { displayPath: candidate, score: 2 };
    }
  }

  return undefined;
}

function hasFileFilters(filters: SearchFilters): boolean {
  return filters.touched.length > 0;
}

function sanitizeFilterValues(values?: string[]): string[] {
  if (!values) {
    return [];
  }

  return values.map((value) => value.trim()).filter((value) => value.length > 0);
}

function boostIndependentHits(hitCount: number): number {
  return hitCount > 1 ? (hitCount - 1) * 0.75 : 0;
}

function escapeLikePrefix(value: string): string {
  return value.replace(/[%_]/g, "\\$&");
}

function normalizeTimeFilter(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }

  return date.toISOString();
}

function buildFtsQuery(query: string): string | undefined {
  const trimmed = query.trim();
  if (!trimmed) {
    return undefined;
  }

  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    return quoteFtsToken(trimmed.slice(1, -1));
  }

  const tokens = trimmed.split(/\s+/).map(sanitizeFtsToken).filter(Boolean);
  if (tokens.length === 0) {
    return undefined;
  }

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
