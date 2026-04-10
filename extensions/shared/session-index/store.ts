import {
  compactSessionId,
  INDEX_SCHEMA_VERSION,
  type SessionFileTouchRow,
  type SessionIndexDatabase,
  type SessionRow,
  type SessionTextChunkRow,
} from "./common.js";

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
  insertSessionIdChunk(db, row);
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
  syncSessionIdChunk(db, row);
}

function insertSessionIdChunk(db: SessionIndexDatabase, row: SessionRow): void {
  insertTextChunk(db, {
    sessionId: row.sessionId,
    entryType: "session_info",
    ts: row.modifiedAt,
    sourceKind: "session_id",
    text: buildSessionIdSearchText(row.sessionId),
  });
}

function syncSessionIdChunk(db: SessionIndexDatabase, row: SessionRow): void {
  db.prepare(
    `DELETE FROM session_text_chunks_fts
     WHERE chunk_id IN (
       SELECT CAST(id AS TEXT) FROM session_text_chunks
       WHERE session_id = ? AND source_kind = 'session_id'
     )`,
  ).run(row.sessionId);

  db.prepare(
    `DELETE FROM session_text_chunks WHERE session_id = ? AND source_kind = 'session_id'`,
  ).run(row.sessionId);

  insertSessionIdChunk(db, row);
}

function buildSessionIdSearchText(sessionId: string): string {
  const compact = compactSessionId(sessionId);
  return compact === sessionId ? sessionId : `${sessionId} ${compact}`;
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
