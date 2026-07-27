import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  clearSessionIndexedData,
  ensureIndexDir,
  initializeSchema,
  insertSessionFileTouch,
  insertTextChunk,
  openIndexDatabase,
  rebuildSessionLineageRelations,
  type SessionIndexDatabase,
  setMetadata,
  upsertSession,
} from "../shared/session-index/index.ts";
import { type ExtractedSessionRecord, extractSessionRecord } from "./extract.ts";

export interface ReindexOptions {
  indexPath: string;
}

export interface ReindexResult {
  sessionCount: number;
  chunkCount: number;
  indexPath: string;
}

export async function rebuildSessionIndex(options: ReindexOptions): Promise<ReindexResult> {
  const indexPath = options.indexPath;
  ensureIndexDir(path.dirname(indexPath));
  const sessionFiles = (await SessionManager.listAll()).map((session) => session.path);

  const db = openIndexDatabase(indexPath, { create: true });
  try {
    db.transaction(() => {
      dropIndexTables(db);
      initializeSchema(db);
    });

    let sessionCount = 0;
    let chunkCount = 0;
    for (const sessionFile of sessionFiles) {
      const extracted = extractSessionRecord(sessionFile);
      if (!extracted) {
        continue;
      }

      db.transaction(() => indexSession(db, extracted));
      sessionCount += 1;
      chunkCount += extracted.chunks.length;
    }

    db.transaction(() => {
      rebuildSessionLineageRelations(db);
      setMetadata(db, "indexed_at", new Date().toISOString());
      setMetadata(db, "session_source", "SessionManager.listAll()");
    });

    return { sessionCount, chunkCount, indexPath };
  } finally {
    db.close();
  }
}

function dropIndexTables(db: SessionIndexDatabase): void {
  // Children before parents: foreign_keys is ON and DROP TABLE runs an
  // implicit DELETE that parent-side constraints would reject.
  db.exec(`
    DROP TABLE IF EXISTS session_lineage_relations;
    DROP TABLE IF EXISTS session_repo_roots;
    DROP TABLE IF EXISTS session_text_chunks;
    DROP TABLE IF EXISTS session_file_touches;
    DROP TABLE IF EXISTS session_text_chunks_fts;
    DROP TABLE IF EXISTS sessions;
    DROP TABLE IF EXISTS metadata;
  `);
}

function indexSession(db: SessionIndexDatabase, extracted: ExtractedSessionRecord): void {
  clearSessionIndexedData(db, extracted.sessionId);
  upsertSession(db, extracted, "full_reindex");

  for (const chunk of extracted.chunks) {
    insertTextChunk(db, { sessionId: extracted.sessionId, ...chunk });
  }

  for (const fileTouch of extracted.fileTouches) {
    insertSessionFileTouch(db, {
      sessionId: extracted.sessionId,
      ...fileTouch,
    });
  }
}
