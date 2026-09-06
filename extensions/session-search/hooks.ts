import { existsSync, type Stats, statSync } from "node:fs";
import {
  clearSessionChunksBySourceKind,
  clearSessionIndexedData,
  getSessionById,
  getSessionRowByPath,
  insertSessionFileTouch,
  insertTextChunk,
  refreshSessionLineageRelationsFor,
  type SessionIndexDatabase,
  type SessionLineageRow,
  type SessionOrigin,
  type SessionRow,
  setMetadata,
  upsertSession,
  withSessionIndex,
} from "../shared/session-index/index.ts";
import {
  createSessionNameChunk,
  type ExtractedSessionRecord,
  type ExtractedSessionTail,
  extractSessionRecord,
  extractSessionTail,
  inferSessionOrigin,
  type SessionFileTouch,
} from "./extract.ts";
import { deriveSessionRepoRoots } from "./normalize.ts";

export interface SessionHookController {
  handleSessionStart(sessionFile: string | undefined): Promise<boolean>;
  handleSessionSwitch(
    previousSessionFile: string | undefined,
    sessionFile: string | undefined,
    sessionOrigin?: SessionOrigin,
  ): Promise<boolean>;
  handleSessionFork(
    previousSessionFile: string | undefined,
    sessionFile: string | undefined,
  ): Promise<boolean>;
  handleTurnEnd(sessionFile: string | undefined): Promise<boolean>;
  handleSessionTree(sessionFile: string | undefined): Promise<boolean>;
  handleSessionCompact(sessionFile: string | undefined): Promise<boolean>;
  handleSessionShutdown(sessionFile: string | undefined): Promise<boolean>;
}

export function createSessionHookController(options: { indexPath: string }): SessionHookController {
  const { indexPath } = options;
  let currentSessionFile: string | undefined;
  const sync = (sessionFile: string | undefined, eventType: string, origin?: SessionOrigin) => {
    currentSessionFile = sessionFile ?? currentSessionFile;
    return syncSessionFile(indexPath, currentSessionFile, eventType, origin);
  };

  return {
    async handleSessionStart(sessionFile) {
      return sync(sessionFile, "session_start");
    },
    async handleSessionSwitch(previousSessionFile, sessionFile, sessionOrigin) {
      const previousSynced = syncSessionFile(indexPath, previousSessionFile, "session_switch");
      const currentSynced = sync(sessionFile, "session_switch", sessionOrigin);
      return previousSynced || currentSynced;
    },
    async handleSessionFork(previousSessionFile, sessionFile) {
      const previousSynced = syncSessionFile(indexPath, previousSessionFile, "session_fork");
      const currentSynced = sync(sessionFile, "session_fork", "fork");
      return previousSynced || currentSynced;
    },
    async handleTurnEnd(sessionFile) {
      return sync(sessionFile, "turn_end");
    },
    async handleSessionTree(sessionFile) {
      return sync(sessionFile, "session_tree");
    },
    async handleSessionCompact(sessionFile) {
      return sync(sessionFile, "session_compact");
    },
    async handleSessionShutdown(sessionFile) {
      try {
        return sync(sessionFile, "session_shutdown");
      } finally {
        currentSessionFile = undefined;
      }
    },
  };
}

function syncSessionFile(
  indexPath: string,
  sessionFile: string | undefined,
  eventType: string,
  sessionOrigin?: SessionOrigin,
): boolean {
  if (!sessionFile || !existsSync(sessionFile)) {
    return false;
  }

  return (
    withSessionIndex(indexPath, { mode: "write", required: false }, ({ db }) => {
      return syncSessionFileWithDb(db, sessionFile, eventType, sessionOrigin);
    }) ?? false
  );
}

interface TailSyncBaseline extends SessionRow {
  indexedFileSize: number;
  indexedFileMtimeMs: number;
  indexedFileAnchor: string;
}

function syncSessionFileWithDb(
  db: SessionIndexDatabase,
  sessionFile: string,
  eventType: string,
  sessionOrigin?: SessionOrigin,
): boolean {
  const baseline = asTailSyncBaseline(getSessionRowByPath(db, sessionFile));
  const stat = statSync(sessionFile);

  if (baseline && isIndexCurrent(baseline, stat, sessionOrigin)) {
    db.transaction(() => writeHookSyncMetadata(db, eventType));
    return true;
  }

  if (baseline && stat.size > baseline.indexedFileSize) {
    const tail = extractSessionTail(sessionFile, baseline);
    if (tail && applyTailSync(db, baseline, tail, eventType, sessionOrigin)) {
      return true;
    }
  }

  const extracted = extractSessionRecord(sessionFile);
  if (!extracted) {
    return false;
  }

  applyFullSync(db, extracted, eventType, sessionOrigin);
  return true;
}

function asTailSyncBaseline(row: SessionRow | undefined): TailSyncBaseline | undefined {
  if (
    !row ||
    row.indexedFileSize === undefined ||
    row.indexedFileMtimeMs === undefined ||
    row.indexedFileAnchor === undefined ||
    row.indexedFileAnchor.length === 0
  ) {
    return undefined;
  }

  return {
    ...row,
    indexedFileSize: row.indexedFileSize,
    indexedFileMtimeMs: row.indexedFileMtimeMs,
    indexedFileAnchor: row.indexedFileAnchor,
  };
}

function isIndexCurrent(
  baseline: TailSyncBaseline,
  stat: Stats,
  sessionOrigin?: SessionOrigin,
): boolean {
  return (
    stat.size === baseline.indexedFileSize &&
    Math.trunc(stat.mtimeMs) === baseline.indexedFileMtimeMs &&
    (sessionOrigin === undefined || sessionOrigin === baseline.sessionOrigin)
  );
}

function applyFullSync(
  db: SessionIndexDatabase,
  extracted: ExtractedSessionRecord,
  eventType: string,
  sessionOrigin?: SessionOrigin,
): void {
  db.transaction(() => {
    const existingSession = getSessionById(db, extracted.sessionId);
    const sessionRow = mergeSessionLineage(extracted, existingSession, sessionOrigin);
    clearSessionIndexedData(db, extracted.sessionId);
    upsertSession(db, sessionRow, "hook");
    if (shouldRefreshLineageRelations(existingSession, sessionRow)) {
      refreshSessionLineageRelationsFor(db, [
        extracted.sessionId,
        existingSession?.parentSessionId,
        sessionRow.parentSessionId,
      ]);
    }

    for (const chunk of extracted.chunks) {
      insertTextChunk(db, { sessionId: extracted.sessionId, ...chunk });
    }

    for (const fileTouch of extracted.fileTouches) {
      insertSessionFileTouch(db, { sessionId: extracted.sessionId, ...fileTouch });
    }

    writeHookSyncMetadata(db, eventType);
  });
}

function applyTailSync(
  db: SessionIndexDatabase,
  baseline: TailSyncBaseline,
  tail: ExtractedSessionTail,
  eventType: string,
  sessionOrigin?: SessionOrigin,
): boolean {
  return db.transaction((): boolean => {
    // Another process may have advanced the index between our baseline read
    // and this transaction; the tail deltas would then double-count.
    const current = getSessionRowByPath(db, baseline.sessionPath);
    if (
      !current ||
      current.sessionId !== baseline.sessionId ||
      current.indexedFileSize !== baseline.indexedFileSize
    ) {
      return false;
    }

    const scan = tail.scan;
    upsertSession(db, buildTailSessionRow(baseline, tail, sessionOrigin), "hook");

    if (scan.sessionName !== undefined && scan.sessionName !== baseline.sessionName) {
      clearSessionChunksBySourceKind(db, baseline.sessionId, "session_name");
      if (scan.sessionName && scan.sessionNameEntryId) {
        insertTextChunk(db, {
          sessionId: baseline.sessionId,
          ...createSessionNameChunk(
            scan.sessionName,
            scan.sessionNameTs ?? baseline.startedAt,
            scan.sessionNameEntryId,
          ),
        });
      }
    }

    if (!baseline.handoffGoal && scan.handoffMetadata) {
      const { entryId, ts, metadata } = scan.handoffMetadata;
      insertTextChunk(db, {
        sessionId: baseline.sessionId,
        entryId,
        entryType: "custom",
        ts,
        sourceKind: "handoff_goal",
        text: metadata.goal,
      });
    }

    for (const chunk of scan.chunks) {
      insertTextChunk(db, { sessionId: baseline.sessionId, ...chunk });
    }

    for (const fileTouch of scan.fileTouches) {
      insertSessionFileTouch(db, { sessionId: baseline.sessionId, ...fileTouch });
    }

    writeHookSyncMetadata(db, eventType);
    return true;
  });
}

function buildTailSessionRow(
  baseline: TailSyncBaseline,
  tail: ExtractedSessionTail,
  sessionOrigin?: SessionOrigin,
): SessionRow {
  const scan = tail.scan;
  const tailHandoffMetadata = baseline.handoffGoal ? undefined : scan.handoffMetadata?.metadata;
  let tailOrigin: SessionOrigin | undefined;
  if (baseline.sessionOrigin !== "subagent" && baseline.sessionOrigin !== "fork") {
    tailOrigin = inferSessionOrigin(
      baseline.sessionId,
      baseline.sessionPath,
      baseline.parentSessionPath,
      tailHandoffMetadata,
    );
  }
  const nextOrigin = resolveSessionOrigin(sessionOrigin, tailOrigin, baseline.sessionOrigin);

  return {
    sessionId: baseline.sessionId,
    sessionPath: baseline.sessionPath,
    sessionName: scan.sessionName ?? baseline.sessionName,
    firstUserPrompt: baseline.firstUserPrompt || (scan.firstUserPrompt ?? ""),
    cwd: baseline.cwd,
    repoRoots: mergeRepoRoots(baseline, scan.fileTouches),
    startedAt: baseline.startedAt,
    modifiedAt:
      scan.maxEntryTs !== undefined && scan.maxEntryTs > baseline.modifiedAt
        ? scan.maxEntryTs
        : baseline.modifiedAt,
    messageCount: baseline.messageCount + scan.messageCount,
    entryCount: baseline.entryCount + scan.entryCount,
    parentSessionPath: baseline.parentSessionPath,
    parentSessionId: baseline.parentSessionId,
    sessionOrigin: baseline.parentSessionPath ? (nextOrigin ?? "unknown_child") : undefined,
    handoffGoal: baseline.handoffGoal ?? tailHandoffMetadata?.goal,
    indexedFileSize: tail.indexedFileSize,
    indexedFileMtimeMs: tail.indexedFileMtimeMs,
    indexedFileAnchor: tail.indexedFileAnchor,
  };
}

function mergeRepoRoots(baseline: TailSyncBaseline, fileTouches: SessionFileTouch[]): string[] {
  const merged = new Set([
    ...baseline.repoRoots,
    ...deriveSessionRepoRoots(baseline.cwd, fileTouches),
  ]);
  return [...merged].sort();
}

function writeHookSyncMetadata(db: SessionIndexDatabase, eventType: string): void {
  setMetadata(db, "hook_updated_at", new Date().toISOString());
  setMetadata(db, "hook_last_event", eventType);
}

function mergeSessionLineage(
  extracted: ExtractedSessionRecord,
  existing: SessionLineageRow | undefined,
  sessionOrigin?: SessionOrigin,
): ExtractedSessionRecord {
  const parentSessionPath = extracted.parentSessionPath ?? existing?.parentSessionPath;
  const parentSessionId = extracted.parentSessionId ?? existing?.parentSessionId;
  const nextOrigin = resolveSessionOrigin(
    sessionOrigin,
    extracted.sessionOrigin,
    existing?.sessionOrigin,
  );

  return {
    ...extracted,
    parentSessionPath,
    parentSessionId,
    sessionOrigin: parentSessionPath ? (nextOrigin ?? "unknown_child") : undefined,
  };
}

function resolveSessionOrigin(
  explicit: SessionOrigin | undefined,
  extracted: SessionOrigin | undefined,
  existing: SessionOrigin | undefined,
): SessionOrigin | undefined {
  if (explicit) {
    return explicit;
  }

  // Preserve a specific origin when the extracted record only knows "unknown_child"
  if (extracted === "unknown_child" && existing && existing !== "unknown_child") {
    return existing;
  }

  return extracted ?? existing;
}

function shouldRefreshLineageRelations(
  existing: SessionLineageRow | undefined,
  next: ExtractedSessionRecord,
): boolean {
  if (!existing) {
    return true;
  }

  return (
    existing.sessionPath !== next.sessionPath ||
    existing.parentSessionPath !== next.parentSessionPath ||
    existing.parentSessionId !== next.parentSessionId
  );
}
