import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { Type } from "@sinclair/typebox";
import Database from "better-sqlite3";
import { parseTypeBoxRows, parseTypeBoxValue, safeParseTypeBoxJson } from "../shared/typebox.js";
import {
  type FileTouchOp,
  type FileTouchSource,
  matchesRepoRoot,
  normalizeSearchPath,
  type PathScope,
} from "./normalize.js";

export const INDEX_SCHEMA_VERSION = 6;

const DEFAULT_SEARCH_LIMIT = 10;
const SEARCH_CANDIDATE_LIMIT = 2_000;
const TEXT_MATCH_ROW_LIMIT = 1_000;

export type SessionOrigin = "handoff" | "fork" | "unknown_child";
export type SessionLineageRelation =
  | "parent"
  | "ancestor"
  | "child"
  | "descendant"
  | "sibling"
  | "ancestor_sibling";

export interface SessionRow {
  sessionId: string;
  sessionPath: string;
  sessionName: string;
  firstUserPrompt?: string | undefined;
  cwd: string;
  repoRoots: string[];
  startedAt: string;
  modifiedAt: string;
  messageCount: number;
  entryCount: number;
  parentSessionPath?: string | undefined;
  parentSessionId?: string | undefined;
  sessionOrigin?: SessionOrigin | undefined;
  handoffGoal?: string | undefined;
  handoffNextTask?: string | undefined;
}

export interface SessionLineageRow {
  sessionId: string;
  sessionPath: string;
  sessionName: string;
  firstUserPrompt?: string | undefined;
  cwd: string;
  repoRoots: string[];
  modifiedAt: string;
  parentSessionPath?: string | undefined;
  parentSessionId?: string | undefined;
  sessionOrigin?: SessionOrigin | undefined;
  handoffGoal?: string | undefined;
  handoffNextTask?: string | undefined;
}

export interface SessionRelatedSessionRow extends SessionLineageRow {
  relation: SessionLineageRelation;
  distance: number;
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
  sessionOrigin?: SessionOrigin | undefined;
  handoffGoal?: string | undefined;
  handoffNextTask?: string | undefined;
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
  entryId: string | null;
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

interface SessionLineageQueryRow {
  sessionId: string;
  sessionPath: string;
  sessionName: string;
  firstUserPrompt: string | null;
  cwd: string;
  repoRootsJson: string;
  modifiedAt: string;
  parentSessionPath: string | null;
  parentSessionId: string | null;
  sessionOrigin: SessionOrigin | null;
  handoffGoal: string | null;
  handoffNextTask: string | null;
}

interface SessionRelatedQueryRow extends SessionLineageQueryRow {
  relation: SessionLineageRelation;
  distance: number;
}

interface SessionGraphRow {
  sessionId: string;
  sessionPath: string;
  parentSessionPath: string | null;
  parentSessionId: string | null;
}

interface SessionGraphNode extends SessionGraphRow {
  resolvedParentSessionId?: string | undefined;
}

interface MaterializedLineageRow {
  sessionId: string;
  relatedSessionId: string;
  relation: SessionLineageRelation;
  distance: number;
}

function sessionLineageColumns(alias?: string): string {
  const p = alias ? `${alias}.` : "";
  return [
    `${p}session_id as sessionId`,
    `${p}session_path as sessionPath`,
    `${p}session_name as sessionName`,
    `${p}first_user_prompt as firstUserPrompt`,
    `${p}cwd`,
    `${p}repo_roots_json as repoRootsJson`,
    `${p}modified_ts as modifiedAt`,
    `${p}parent_session_path as parentSessionPath`,
    `${p}parent_session_id as parentSessionId`,
    `${p}session_origin as sessionOrigin`,
    `${p}handoff_goal as handoffGoal`,
    `${p}handoff_next_task as handoffNextTask`,
  ].join(",\n          ");
}

interface FileTouchMatchRow {
  sessionId: string;
  rawPath: string;
  absPath: string | null;
  cwdRelPath: string | null;
  repoRelPath: string | null;
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

const NULLABLE_STRING_SCHEMA = Type.Union([Type.String(), Type.Null()]);
const SESSION_ORIGIN_SCHEMA = Type.Union([
  Type.Literal("handoff"),
  Type.Literal("fork"),
  Type.Literal("unknown_child"),
]);
const SESSION_LINEAGE_RELATION_SCHEMA = Type.Union([
  Type.Literal("parent"),
  Type.Literal("ancestor"),
  Type.Literal("child"),
  Type.Literal("descendant"),
  Type.Literal("sibling"),
  Type.Literal("ancestor_sibling"),
]);
const ROW_COUNT_SCHEMA = Type.Object({
  count: Type.Number(),
});
const METADATA_ROW_SCHEMA = Type.Object({
  value: Type.String(),
});
const SESSION_GRAPH_ROW_SCHEMA = Type.Object({
  sessionId: Type.String(),
  sessionPath: Type.String(),
  parentSessionPath: NULLABLE_STRING_SCHEMA,
  parentSessionId: NULLABLE_STRING_SCHEMA,
});
const SESSION_LIST_ROW_SCHEMA = Type.Object({
  sessionId: Type.String(),
  sessionName: Type.String(),
  sessionPath: Type.String(),
  cwd: Type.String(),
  repoRootsJson: Type.String(),
  startedAt: Type.String(),
  modifiedAt: Type.String(),
});
const SEARCH_CHUNK_ROW_SCHEMA = Type.Object({
  sessionId: Type.String(),
  sessionName: Type.String(),
  sessionPath: Type.String(),
  cwd: Type.String(),
  repoRootsJson: Type.String(),
  startedAt: Type.String(),
  modifiedAt: Type.String(),
  snippet: Type.String(),
  rank: Type.Number(),
  entryId: NULLABLE_STRING_SCHEMA,
  sourceKind: Type.String(),
});
const FILE_TOUCH_MATCH_ROW_SCHEMA = Type.Object({
  sessionId: Type.String(),
  rawPath: Type.String(),
  absPath: NULLABLE_STRING_SCHEMA,
  cwdRelPath: NULLABLE_STRING_SCHEMA,
  repoRelPath: NULLABLE_STRING_SCHEMA,
  basename: Type.String(),
  op: Type.Union([Type.Literal("read"), Type.Literal("changed")]),
});
const SESSION_LINEAGE_QUERY_ROW_SCHEMA = Type.Object({
  sessionId: Type.String(),
  sessionPath: Type.String(),
  sessionName: Type.String(),
  firstUserPrompt: NULLABLE_STRING_SCHEMA,
  cwd: Type.String(),
  repoRootsJson: Type.String(),
  modifiedAt: Type.String(),
  parentSessionPath: NULLABLE_STRING_SCHEMA,
  parentSessionId: NULLABLE_STRING_SCHEMA,
  sessionOrigin: Type.Union([SESSION_ORIGIN_SCHEMA, Type.Null()]),
  handoffGoal: NULLABLE_STRING_SCHEMA,
  handoffNextTask: NULLABLE_STRING_SCHEMA,
});
const SESSION_RELATED_QUERY_ROW_SCHEMA = Type.Intersect([
  SESSION_LINEAGE_QUERY_ROW_SCHEMA,
  Type.Object({
    relation: SESSION_LINEAGE_RELATION_SCHEMA,
    distance: Type.Number(),
  }),
]);
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

function sessionRowBindings(
  row: SessionRow,
  indexSource: string,
): [
  string,
  string,
  string,
  string | null,
  string,
  string,
  string,
  string,
  number,
  number,
  string | null,
  string | null,
  SessionOrigin | null,
  string | null,
  string | null,
  number,
  string,
  string,
] {
  return [
    row.sessionId,
    row.sessionPath,
    row.sessionName,
    row.firstUserPrompt ?? null,
    row.cwd,
    JSON.stringify(row.repoRoots),
    row.startedAt,
    row.modifiedAt,
    row.messageCount,
    row.entryCount,
    row.parentSessionPath ?? null,
    row.parentSessionId ?? null,
    row.sessionOrigin ?? null,
    row.handoffGoal ?? null,
    row.handoffNextTask ?? null,
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
        session_id, session_path, session_name, first_user_prompt, cwd, repo_roots_json,
        created_ts, modified_ts, message_count, entry_count,
        parent_session_path, parent_session_id, session_origin,
        handoff_goal, handoff_next_task,
        index_version, indexed_at_ts, index_source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        session_id, session_path, session_name, first_user_prompt, cwd, repo_roots_json,
        created_ts, modified_ts, message_count, entry_count,
        parent_session_path, parent_session_id, session_origin,
        handoff_goal, handoff_next_task,
        index_version, indexed_at_ts, index_source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET
        session_path = excluded.session_path,
        session_name = excluded.session_name,
        first_user_prompt = excluded.first_user_prompt,
        cwd = excluded.cwd,
        repo_roots_json = excluded.repo_roots_json,
        created_ts = excluded.created_ts,
        modified_ts = excluded.modified_ts,
        message_count = excluded.message_count,
        entry_count = excluded.entry_count,
        parent_session_path = excluded.parent_session_path,
        parent_session_id = excluded.parent_session_id,
        session_origin = excluded.session_origin,
        handoff_goal = excluded.handoff_goal,
        handoff_next_task = excluded.handoff_next_task,
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

export function rebuildSessionLineageRelations(db: SessionIndexDatabase): void {
  db.prepare(`DELETE FROM session_lineage_relations`).run();

  const rows = parseTypeBoxRows(
    SESSION_GRAPH_ROW_SCHEMA,
    db
      .prepare(
        `
          SELECT
            session_id as sessionId,
            session_path as sessionPath,
            parent_session_path as parentSessionPath,
            parent_session_id as parentSessionId
          FROM sessions
        `,
      )
      .all(),
    "Invalid session graph rows",
  );

  const pathToId = new Map(rows.map((row) => [row.sessionPath, row.sessionId]));
  const nodes = new Map<string, SessionGraphNode>(
    rows.map((row) => [
      row.sessionId,
      {
        ...row,
        resolvedParentSessionId:
          row.parentSessionId ??
          (row.parentSessionPath ? pathToId.get(row.parentSessionPath) : undefined),
      },
    ]),
  );
  const childrenByParent = new Map<string, string[]>();

  for (const node of nodes.values()) {
    if (!node.resolvedParentSessionId) {
      continue;
    }

    const children = childrenByParent.get(node.resolvedParentSessionId) ?? [];
    children.push(node.sessionId);
    childrenByParent.set(node.resolvedParentSessionId, children);
  }

  const insertRelation = db.prepare(
    `
      INSERT INTO session_lineage_relations(session_id, related_session_id, relation, distance)
      VALUES (?, ?, ?, ?)
    `,
  );

  for (const node of nodes.values()) {
    const relations = collectMaterializedLineageRows(node.sessionId, nodes, childrenByParent);
    for (const relation of relations.values()) {
      insertRelation.run(
        relation.sessionId,
        relation.relatedSessionId,
        relation.relation,
        relation.distance,
      );
    }
  }
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

export function getSessionById(
  db: SessionIndexDatabase,
  sessionId: string,
): SessionLineageRow | undefined {
  const row = db
    .prepare(
      `
        SELECT ${sessionLineageColumns()}
        FROM sessions
        WHERE session_id = ?
      `,
    )
    .get(sessionId);

  if (row === undefined) {
    return undefined;
  }

  return buildSessionLineageRow(
    parseTypeBoxValue(
      SESSION_LINEAGE_QUERY_ROW_SCHEMA,
      row,
      `Invalid session row for ${sessionId}`,
    ),
  );
}

export function getSessionByPath(
  db: SessionIndexDatabase,
  sessionPath: string,
): SessionLineageRow | undefined {
  const row = db
    .prepare(
      `
        SELECT ${sessionLineageColumns()}
        FROM sessions
        WHERE session_path = ?
      `,
    )
    .get(sessionPath);

  if (row === undefined) {
    return undefined;
  }

  return buildSessionLineageRow(
    parseTypeBoxValue(
      SESSION_LINEAGE_QUERY_ROW_SCHEMA,
      row,
      `Invalid session row for path ${sessionPath}`,
    ),
  );
}

export function findSessionsByIdPrefix(
  db: SessionIndexDatabase,
  prefix: string,
  limit: number = DEFAULT_SEARCH_LIMIT,
): SessionLineageRow[] {
  const rows = parseTypeBoxRows(
    SESSION_LINEAGE_QUERY_ROW_SCHEMA,
    db
      .prepare(
        `
          SELECT ${sessionLineageColumns()}
          FROM sessions
          WHERE session_id LIKE ? ESCAPE '\\'
          ORDER BY modified_ts DESC
          LIMIT ?
        `,
      )
      .all(`${escapeLikePrefix(prefix)}%`, limit),
    `Invalid session prefix rows for ${prefix}`,
  );

  return rows.map(buildSessionLineageRow);
}

export function getLineageSessions(
  db: SessionIndexDatabase,
  sessionId: string,
): SessionRelatedSessionRow[] {
  return queryRelatedSessions(db, sessionId);
}

export function getParentSession(
  db: SessionIndexDatabase,
  sessionId: string,
): SessionLineageRow | undefined {
  return queryRelatedSessions(db, sessionId, ["parent"])[0];
}

export function getAncestorSessions(
  db: SessionIndexDatabase,
  sessionId: string,
): SessionLineageRow[] {
  return queryRelatedSessions(db, sessionId, ["parent", "ancestor"]);
}

export function getChildSessions(db: SessionIndexDatabase, sessionId: string): SessionLineageRow[] {
  return queryRelatedSessions(db, sessionId, ["child"]);
}

export function getSiblingSessions(
  db: SessionIndexDatabase,
  sessionId: string,
): SessionLineageRow[] {
  return queryRelatedSessions(db, sessionId, ["sibling"]);
}

export function getLineageAutocompleteSessions(
  db: SessionIndexDatabase,
  sessionId: string,
  prefix: string,
  limit?: number,
): SessionRelatedSessionRow[] {
  const normalizedPrefix = prefix.trim();
  const limitClause = typeof limit === "number" ? "\n        LIMIT ?" : "";
  const params: Array<string | number> = [
    sessionId,
    normalizedPrefix,
    `${escapeLikePrefix(normalizedPrefix)}%`,
  ];
  if (typeof limit === "number") {
    params.push(limit);
  }

  const rows = parseTypeBoxRows(
    SESSION_RELATED_QUERY_ROW_SCHEMA,
    db
      .prepare(
        `
          SELECT
            ${sessionLineageColumns("s")},
            r.relation as relation,
            r.distance as distance
          FROM session_lineage_relations r
          JOIN sessions s ON s.session_id = r.related_session_id
          WHERE r.session_id = ?
            AND (? = '' OR s.session_id LIKE ? ESCAPE '\\')
          ORDER BY
            CASE r.relation
              WHEN 'parent' THEN 1
              WHEN 'child' THEN 2
              WHEN 'sibling' THEN 3
              WHEN 'ancestor' THEN 4
              WHEN 'descendant' THEN 5
              WHEN 'ancestor_sibling' THEN 6
              ELSE 7
            END ASC,
            r.distance ASC,
            s.modified_ts DESC${limitClause}
        `,
      )
      .all(...params),
    `Invalid lineage autocomplete rows for ${sessionId}`,
  );

  return rows.map(buildRelatedSessionRow);
}

export function getRecentAutocompleteSessions(
  db: SessionIndexDatabase,
  prefix: string,
  limit?: number,
  options?: { excludeSessionId?: string | undefined; preferredCwd?: string | undefined },
): SessionLineageRow[] {
  const normalizedPrefix = prefix.trim();
  const limitClause = typeof limit === "number" ? "\n        LIMIT ?" : "";
  const params: Array<string | number | null> = [
    options?.excludeSessionId ?? null,
    options?.excludeSessionId ?? null,
    normalizedPrefix,
    `${escapeLikePrefix(normalizedPrefix)}%`,
    options?.preferredCwd ?? null,
    options?.preferredCwd ?? null,
  ];
  if (typeof limit === "number") {
    params.push(limit);
  }

  const rows = parseTypeBoxRows(
    SESSION_LINEAGE_QUERY_ROW_SCHEMA,
    db
      .prepare(
        `
          SELECT ${sessionLineageColumns()}
          FROM sessions
          WHERE (? IS NULL OR session_id != ?)
            AND (? = '' OR session_id LIKE ? ESCAPE '\\')
          ORDER BY
            CASE
              WHEN ? IS NOT NULL AND cwd = ? THEN 0
              ELSE 1
            END ASC,
            modified_ts DESC${limitClause}
        `,
      )
      .all(...params),
    `Invalid recent autocomplete rows for ${prefix}`,
  );

  return rows.map(buildSessionLineageRow);
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
  const rows = parseTypeBoxRows(
    SESSION_LIST_ROW_SCHEMA,
    db
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
            AND (? IS NULL OR created_ts <= ?)
            AND (? IS NULL OR cwd = ? OR cwd LIKE ? ESCAPE '\\')
          ORDER BY modified_ts DESC
          LIMIT ?
        `,
      )
      .all(...getSearchFilterBindings(filters), SEARCH_CANDIDATE_LIMIT),
    "Invalid recent session rows",
  );

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

  const rows = parseTypeBoxRows(
    SEARCH_CHUNK_ROW_SCHEMA,
    db
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
          AND (? IS NULL OR s.created_ts <= ?)
          AND (? IS NULL OR s.cwd = ? OR s.cwd LIKE ? ESCAPE '\\')
        ORDER BY rank ASC, s.modified_ts DESC
        LIMIT ?
      `,
      )
      .all(match, ...getSearchFilterBindings(filters), TEXT_MATCH_ROW_LIMIT),
    "Invalid text search rows",
  );

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
  return parseTypeBoxRows(
    FILE_TOUCH_MATCH_ROW_SCHEMA,
    db
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
            AND (? IS NULL OR s.created_ts <= ?)
            AND (? IS NULL OR s.cwd = ? OR s.cwd LIKE ? ESCAPE '\\')
        `,
      )
      .all(...getSearchFilterBindings(filters)),
    "Invalid file touch match rows",
  );
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

function queryRelatedSessions(
  db: SessionIndexDatabase,
  sessionId: string,
  relations?: SessionLineageRelation[],
): SessionRelatedSessionRow[] {
  const relationFilter = relations?.length
    ? ` AND r.relation IN (${relations.map(() => "?").join(", ")})`
    : "";
  const rows = parseTypeBoxRows(
    SESSION_RELATED_QUERY_ROW_SCHEMA,
    db
      .prepare(
        `
          SELECT
            ${sessionLineageColumns("s")},
            r.relation as relation,
            r.distance as distance
          FROM session_lineage_relations r
          JOIN sessions s ON s.session_id = r.related_session_id
          WHERE r.session_id = ?${relationFilter}
          ORDER BY
            CASE r.relation
              WHEN 'parent' THEN 1
              WHEN 'child' THEN 2
              WHEN 'sibling' THEN 3
              WHEN 'ancestor' THEN 4
              WHEN 'descendant' THEN 5
              WHEN 'ancestor_sibling' THEN 6
              ELSE 7
            END ASC,
            r.distance ASC,
            s.modified_ts DESC
        `,
      )
      .all(sessionId, ...(relations ?? [])),
    `Invalid related session rows for ${sessionId}`,
  );

  return rows.map(buildRelatedSessionRow);
}

function buildSessionLineageRow(row: SessionLineageQueryRow): SessionLineageRow {
  return {
    sessionId: row.sessionId,
    sessionPath: row.sessionPath,
    sessionName: row.sessionName,
    firstUserPrompt: row.firstUserPrompt ?? undefined,
    cwd: row.cwd,
    repoRoots: parseRepoRoots(row.repoRootsJson),
    modifiedAt: row.modifiedAt,
    parentSessionPath: row.parentSessionPath ?? undefined,
    parentSessionId: row.parentSessionId ?? undefined,
    sessionOrigin: row.sessionOrigin ?? undefined,
    handoffGoal: row.handoffGoal ?? undefined,
    handoffNextTask: row.handoffNextTask ?? undefined,
  };
}

function buildRelatedSessionRow(row: SessionRelatedQueryRow): SessionRelatedSessionRow {
  return {
    ...buildSessionLineageRow(row),
    relation: row.relation,
    distance: row.distance,
  };
}

function collectMaterializedLineageRows(
  sessionId: string,
  nodes: Map<string, SessionGraphNode>,
  childrenByParent: Map<string, string[]>,
): Map<string, MaterializedLineageRow> {
  const relations = new Map<string, MaterializedLineageRow>();
  const visitedAncestors = new Set<string>();
  const ancestors: Array<{ sessionId: string; distance: number }> = [];

  let currentId = nodes.get(sessionId)?.resolvedParentSessionId;
  let distance = 1;
  while (currentId && !visitedAncestors.has(currentId)) {
    visitedAncestors.add(currentId);
    ancestors.push({ sessionId: currentId, distance });
    setMaterializedLineageRow(relations, {
      sessionId,
      relatedSessionId: currentId,
      relation: distance === 1 ? "parent" : "ancestor",
      distance,
    });
    currentId = nodes.get(currentId)?.resolvedParentSessionId;
    distance += 1;
  }

  const visitedDescendants = new Set<string>();
  const queue = (childrenByParent.get(sessionId) ?? []).map((childId) => ({
    childId,
    distance: 1,
  }));
  while (queue.length > 0) {
    const next = queue.shift();
    if (!next || visitedDescendants.has(next.childId)) {
      continue;
    }

    visitedDescendants.add(next.childId);
    setMaterializedLineageRow(relations, {
      sessionId,
      relatedSessionId: next.childId,
      relation: next.distance === 1 ? "child" : "descendant",
      distance: next.distance,
    });

    for (const childId of childrenByParent.get(next.childId) ?? []) {
      queue.push({ childId, distance: next.distance + 1 });
    }
  }

  const parentId = nodes.get(sessionId)?.resolvedParentSessionId;
  if (parentId) {
    for (const siblingId of childrenByParent.get(parentId) ?? []) {
      if (siblingId === sessionId) {
        continue;
      }

      setMaterializedLineageRow(relations, {
        sessionId,
        relatedSessionId: siblingId,
        relation: "sibling",
        distance: 1,
      });
    }
  }

  for (const ancestor of ancestors) {
    const ancestorParentId = nodes.get(ancestor.sessionId)?.resolvedParentSessionId;
    if (!ancestorParentId) {
      continue;
    }

    for (const siblingId of childrenByParent.get(ancestorParentId) ?? []) {
      if (siblingId === ancestor.sessionId) {
        continue;
      }

      setMaterializedLineageRow(relations, {
        sessionId,
        relatedSessionId: siblingId,
        relation: "ancestor_sibling",
        distance: ancestor.distance + 1,
      });
    }
  }

  return relations;
}

function setMaterializedLineageRow(
  rows: Map<string, MaterializedLineageRow>,
  candidate: MaterializedLineageRow,
): void {
  const existing = rows.get(candidate.relatedSessionId);
  if (!existing) {
    rows.set(candidate.relatedSessionId, candidate);
    return;
  }

  const existingPriority = getLineageRelationPriority(existing.relation);
  const candidatePriority = getLineageRelationPriority(candidate.relation);
  if (candidatePriority < existingPriority) {
    rows.set(candidate.relatedSessionId, candidate);
    return;
  }

  if (candidatePriority === existingPriority && candidate.distance < existing.distance) {
    rows.set(candidate.relatedSessionId, candidate);
  }
}

function getLineageRelationPriority(relation: SessionLineageRelation): number {
  switch (relation) {
    case "parent":
      return 1;
    case "child":
      return 2;
    case "sibling":
      return 3;
    case "ancestor":
      return 4;
    case "descendant":
      return 5;
    case "ancestor_sibling":
      return 6;
  }
}

function parseRepoRoots(value: string): string[] {
  return safeParseTypeBoxJson(Type.Array(Type.String()), value) ?? [];
}
