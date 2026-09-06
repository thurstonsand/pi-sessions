import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
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
import { type ExtractedSessionRecord, extractSessionRecord, listSessionFiles } from "./extract.ts";

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
  const sessionFiles = listSessionFiles(path.join(getAgentDir(), "sessions"));

  const db = openIndexDatabase(indexPath, { create: true });
  try {
    db.transaction(() => {
      dropIndexTables(db);
      initializeSchema(db);
    });

    const indexedSessions = new Map<string, { modifiedAt: string; chunks: number }>();
    let chunkCount = 0;
    for (const sessionFile of sessionFiles) {
      const extracted = extractSessionRecord(sessionFile);
      if (!extracted) {
        continue;
      }

      const previous = indexedSessions.get(extracted.sessionId);
      if (previous && previous.modifiedAt > extracted.modifiedAt) continue;
      db.transaction(() => indexSession(db, extracted));
      chunkCount += extracted.chunks.length - (previous?.chunks ?? 0);
      indexedSessions.set(extracted.sessionId, {
        modifiedAt: extracted.modifiedAt,
        chunks: extracted.chunks.length,
      });
    }

    db.transaction(() => {
      rebuildSessionLineageRelations(db);
      setMetadata(db, "indexed_at", new Date().toISOString());
      setMetadata(db, "session_source", "session files");
    });

    return { sessionCount: indexedSessions.size, chunkCount, indexPath };
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
