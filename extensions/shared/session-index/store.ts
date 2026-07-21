import path from "node:path";
import { type Static, Type } from "typebox";
import { parseTypeBoxValue } from "../typebox.ts";
import {
  INDEX_SCHEMA_VERSION,
  NULLABLE_STRING_SCHEMA,
  parseRepoRoots,
  SESSION_ORIGIN_SCHEMA,
  type SessionFileTouchRow,
  type SessionIndexDatabase,
  type SessionRow,
  type SessionTextChunkRow,
} from "./common.ts";

const SESSION_ROW_QUERY_SCHEMA = Type.Object({
  sessionId: Type.String(),
  sessionPath: Type.String(),
  sessionName: Type.String(),
  firstUserPrompt: NULLABLE_STRING_SCHEMA,
  cwd: Type.String(),
  repoRootsJson: Type.String(),
  startedAt: Type.String(),
  modifiedAt: Type.String(),
  messageCount: Type.Number(),
  entryCount: Type.Number(),
  parentSessionPath: NULLABLE_STRING_SCHEMA,
  parentSessionId: NULLABLE_STRING_SCHEMA,
  sessionOrigin: Type.Union([SESSION_ORIGIN_SCHEMA, Type.Null()]),
  handoffGoal: NULLABLE_STRING_SCHEMA,
  indexedFileSize: Type.Union([Type.Number(), Type.Null()]),
  indexedFileMtimeMs: Type.Union([Type.Number(), Type.Null()]),
  indexedFileAnchor: NULLABLE_STRING_SCHEMA,
});

function sessionRowBindings(row: SessionRow, indexSource: string) {
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
    row.indexedFileSize ?? null,
    row.indexedFileMtimeMs ?? null,
    row.indexedFileAnchor ?? null,
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
        handoff_goal,
        indexed_file_size, indexed_file_mtime_ms, indexed_file_anchor,
        index_version, indexed_at_ts, index_source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(...sessionRowBindings(row, indexSource));
  syncSessionRepoRoots(db, row);
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
        handoff_goal,
        indexed_file_size, indexed_file_mtime_ms, indexed_file_anchor,
        index_version, indexed_at_ts, index_source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        indexed_file_size = excluded.indexed_file_size,
        indexed_file_mtime_ms = excluded.indexed_file_mtime_ms,
        indexed_file_anchor = excluded.indexed_file_anchor,
        index_version = excluded.index_version,
        indexed_at_ts = excluded.indexed_at_ts,
        index_source = excluded.index_source
    `,
  ).run(...sessionRowBindings(row, indexSource));
  syncSessionRepoRoots(db, row);
}

export function getSessionRowByPath(
  db: SessionIndexDatabase,
  sessionPath: string,
): SessionRow | undefined {
  const row = db
    .prepare(
      `
        SELECT
          session_id as sessionId,
          session_path as sessionPath,
          session_name as sessionName,
          first_user_prompt as firstUserPrompt,
          cwd,
          repo_roots_json as repoRootsJson,
          created_ts as startedAt,
          modified_ts as modifiedAt,
          message_count as messageCount,
          entry_count as entryCount,
          parent_session_path as parentSessionPath,
          parent_session_id as parentSessionId,
          session_origin as sessionOrigin,
          handoff_goal as handoffGoal,
          indexed_file_size as indexedFileSize,
          indexed_file_mtime_ms as indexedFileMtimeMs,
          indexed_file_anchor as indexedFileAnchor
        FROM sessions
        WHERE session_path = ?
        ORDER BY indexed_at_ts DESC
        LIMIT 1
      `,
    )
    .get(sessionPath);

  if (row === undefined || row === null) {
    return undefined;
  }

  return buildSessionRow(
    parseTypeBoxValue(SESSION_ROW_QUERY_SCHEMA, row, `Invalid session row for path ${sessionPath}`),
  );
}

function buildSessionRow(row: Static<typeof SESSION_ROW_QUERY_SCHEMA>): SessionRow {
  return {
    sessionId: row.sessionId,
    sessionPath: row.sessionPath,
    sessionName: row.sessionName,
    firstUserPrompt: row.firstUserPrompt ?? undefined,
    cwd: row.cwd,
    repoRoots: parseRepoRoots(row.repoRootsJson),
    startedAt: row.startedAt,
    modifiedAt: row.modifiedAt,
    messageCount: row.messageCount,
    entryCount: row.entryCount,
    parentSessionPath: row.parentSessionPath ?? undefined,
    parentSessionId: row.parentSessionId ?? undefined,
    sessionOrigin: row.sessionOrigin ?? undefined,
    handoffGoal: row.handoffGoal ?? undefined,
    indexedFileSize: row.indexedFileSize ?? undefined,
    indexedFileMtimeMs: row.indexedFileMtimeMs ?? undefined,
    indexedFileAnchor: row.indexedFileAnchor ?? undefined,
  };
}

function syncSessionRepoRoots(db: SessionIndexDatabase, row: SessionRow): void {
  db.prepare(`DELETE FROM session_repo_roots WHERE session_id = ?`).run(row.sessionId);

  const insert = db.prepare(
    `INSERT INTO session_repo_roots(session_id, repo_root, repo_basename) VALUES (?, ?, ?)`,
  );
  for (const repoRoot of [...new Set(row.repoRoots)]) {
    insert.run(row.sessionId, repoRoot, path.basename(repoRoot));
  }
}

export function clearSessionChunksBySourceKind(
  db: SessionIndexDatabase,
  sessionId: string,
  sourceKind: string,
): void {
  db.prepare(`DELETE FROM session_text_chunks WHERE session_id = ? AND source_kind = ?`).run(
    sessionId,
    sourceKind,
  );
}

export function clearSessionIndexedData(db: SessionIndexDatabase, sessionId: string): void {
  db.prepare(`DELETE FROM session_text_chunks WHERE session_id = ?`).run(sessionId);
  db.prepare(`DELETE FROM session_file_touches WHERE session_id = ?`).run(sessionId);
}

export function insertTextChunk(db: SessionIndexDatabase, row: SessionTextChunkRow): void {
  db.prepare(
    `
      INSERT INTO session_text_chunks(
        session_id, entry_id, entry_type, role, ts, source_kind, text
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `,
  ).run(
    row.sessionId,
    row.entryId,
    row.entryType,
    row.role ?? null,
    row.ts,
    row.sourceKind,
    row.text,
  );
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
