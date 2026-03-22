import { renameSync } from "node:fs";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import {
  createTempIndexPath,
  getDefaultIndexPath,
  initializeSchema,
  insertSession,
  insertTextChunk,
  openIndexDatabase,
  type SessionIndexDatabase,
  setMetadata,
} from "./db.js";
import { extractSessionRecord, type SearchTextChunk } from "./extract.js";

export interface ReindexOptions {
  indexPath?: string;
}

export interface ReindexResult {
  sessionCount: number;
  chunkCount: number;
  indexPath: string;
}

export async function rebuildSessionIndex(options?: ReindexOptions): Promise<ReindexResult> {
  const finalIndexPath = options?.indexPath ?? getDefaultIndexPath();
  const tempIndexPath = createTempIndexPath(finalIndexPath);
  const sessionFiles = (await SessionManager.listAll()).map((session) => session.path);

  let db: SessionIndexDatabase | undefined;
  try {
    db = openIndexDatabase(tempIndexPath, { create: true });
    initializeSchema(db);
    const { sessionCount, chunkCount } = indexSessionFiles(db, sessionFiles);
    db.close();
    db = undefined;

    renameSync(tempIndexPath, finalIndexPath);

    return {
      sessionCount,
      chunkCount,
      indexPath: finalIndexPath,
    };
  } catch (error) {
    db?.close();
    throw error;
  }
}

function indexSessionFiles(
  db: SessionIndexDatabase,
  sessionFiles: string[],
): { sessionCount: number; chunkCount: number } {
  return db.transaction((files: string[]) => {
    let sessionCount = 0;
    let chunkCount = 0;

    for (const sessionFile of files) {
      const extracted = extractSessionRecord(sessionFile);
      if (!extracted) {
        continue;
      }

      insertSession(db, extracted, "full_reindex");
      sessionCount += 1;
      chunkCount += insertSessionChunks(db, extracted.sessionId, extracted.chunks);
    }

    setMetadata(db, "indexed_at", new Date().toISOString());
    setMetadata(db, "session_source", "SessionManager.listAll()");

    return { sessionCount, chunkCount };
  })(sessionFiles);
}

function insertSessionChunks(
  db: SessionIndexDatabase,
  sessionId: string,
  chunks: SearchTextChunk[],
): number {
  let chunkCount = 0;

  for (const chunk of chunks) {
    insertTextChunk(db, {
      sessionId,
      entryId: chunk.entryId,
      entryType: chunk.entryType,
      role: chunk.role,
      ts: chunk.ts,
      sourceKind: chunk.sourceKind,
      text: chunk.text,
    });
    chunkCount += 1;
  }

  return chunkCount;
}
