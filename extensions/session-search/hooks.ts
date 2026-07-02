import { existsSync, type Stats, statSync } from "node:fs";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import {
  isToolCallEventType,
  type ToolCallEvent,
  type ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import {
  clearSessionChunksBySourceKind,
  clearSessionIndexedData,
  getMetadata,
  getSessionById,
  getSessionRowByPath,
  INDEX_SCHEMA_VERSION,
  insertSessionFileTouch,
  insertTextChunk,
  openIndexDatabase,
  refreshSessionLineageRelationsFor,
  type SessionIndexDatabase,
  type SessionLineageRow,
  type SessionOrigin,
  type SessionRow,
  setMetadata,
  upsertSession,
} from "../shared/session-index/index.ts";
import {
  createSessionNameChunk,
  type ExtractedSessionRecord,
  type ExtractedSessionTail,
  extractSessionRecord,
  extractSessionTail,
  type SessionFileTouch,
} from "./extract.ts";
import { deriveSessionRepoRoots } from "./normalize.ts";

const TOOL_RESULT_TEXT_LIMIT = 500;

type TrackedToolName = "read" | "edit" | "write";

export interface PendingToolCall {
  toolCallId: string;
  toolName: TrackedToolName;
  path: string;
}

export interface FinalizedToolCall extends PendingToolCall {
  isError: boolean;
  resultText: string;
}

export interface SessionHookStateSnapshot {
  currentSessionFile?: string | undefined;
  currentCwd?: string | undefined;
  pendingToolCalls: PendingToolCall[];
  finalizedToolCalls: FinalizedToolCall[];
  lastFlushedSessionFile?: string | undefined;
}

export interface SessionHookController {
  getState(): SessionHookStateSnapshot;
  handleSessionStart(sessionFile: string | undefined, cwd: string): Promise<boolean>;
  handleSessionSwitch(
    previousSessionFile: string | undefined,
    sessionFile: string | undefined,
    cwd: string,
    sessionOrigin?: SessionOrigin,
  ): Promise<boolean>;
  handleSessionFork(
    previousSessionFile: string | undefined,
    sessionFile: string | undefined,
    cwd: string,
  ): Promise<boolean>;
  handleToolCall(event: ToolCallEvent, sessionFile: string | undefined, cwd: string): void;
  handleToolResult(event: ToolResultEvent): void;
  handleTurnEnd(sessionFile: string | undefined, cwd: string): Promise<boolean>;
  handleSessionTree(sessionFile: string | undefined, cwd: string): Promise<boolean>;
  handleSessionCompact(sessionFile: string | undefined, cwd: string): Promise<boolean>;
  handleSessionShutdown(sessionFile: string | undefined, cwd: string): Promise<boolean>;
}

interface SessionHookState {
  currentSessionFile?: string | undefined;
  currentCwd?: string | undefined;
  pendingToolCalls: Map<string, PendingToolCall>;
  finalizedToolCalls: Map<string, FinalizedToolCall>;
  lastFlushedSessionFile?: string | undefined;
}

export function createSessionHookController(options: { indexPath: string }): SessionHookController {
  const { indexPath } = options;
  const state: SessionHookState = {
    pendingToolCalls: new Map(),
    finalizedToolCalls: new Map(),
  };

  return {
    getState() {
      return {
        currentSessionFile: state.currentSessionFile,
        currentCwd: state.currentCwd,
        pendingToolCalls: [...state.pendingToolCalls.values()],
        finalizedToolCalls: [...state.finalizedToolCalls.values()],
        lastFlushedSessionFile: state.lastFlushedSessionFile,
      };
    },
    async handleSessionStart(sessionFile, cwd) {
      attachSession(state, sessionFile, cwd);
      return syncAttachedSession(indexPath, state, "session_start");
    },
    async handleSessionSwitch(previousSessionFile, sessionFile, cwd, sessionOrigin) {
      const previousSynced = syncSessionFile(indexPath, previousSessionFile, "session_switch");
      attachSession(state, sessionFile, cwd);
      const currentSynced = syncAttachedSession(indexPath, state, "session_switch", sessionOrigin);
      return previousSynced || currentSynced;
    },
    async handleSessionFork(previousSessionFile, sessionFile, cwd) {
      const previousSynced = syncSessionFile(indexPath, previousSessionFile, "session_fork");
      attachSession(state, sessionFile, cwd);
      const currentSynced = syncAttachedSession(indexPath, state, "session_fork", "fork");
      return previousSynced || currentSynced;
    },
    handleToolCall(event, sessionFile, cwd) {
      attachSession(state, sessionFile, cwd);
      const pendingToolCall = buildPendingToolCall(event);
      if (!pendingToolCall) {
        return;
      }

      state.pendingToolCalls.set(event.toolCallId, pendingToolCall);
    },
    handleToolResult(event) {
      const pendingToolCall = state.pendingToolCalls.get(event.toolCallId);
      if (!pendingToolCall) {
        return;
      }

      state.pendingToolCalls.delete(event.toolCallId);
      state.finalizedToolCalls.set(event.toolCallId, {
        ...pendingToolCall,
        isError: event.isError,
        resultText: summarizeToolResultText(event.toolName, event.content),
      });
    },
    async handleTurnEnd(sessionFile, cwd) {
      attachSession(state, sessionFile, cwd);
      try {
        return syncAttachedSession(indexPath, state, "turn_end");
      } finally {
        clearTurnState(state);
      }
    },
    async handleSessionTree(sessionFile, cwd) {
      attachSession(state, sessionFile, cwd);
      return syncAttachedSession(indexPath, state, "session_tree");
    },
    async handleSessionCompact(sessionFile, cwd) {
      attachSession(state, sessionFile, cwd);
      return syncAttachedSession(indexPath, state, "session_compact");
    },
    async handleSessionShutdown(sessionFile, cwd) {
      attachSession(state, sessionFile, cwd);
      try {
        return syncAttachedSession(indexPath, state, "session_shutdown");
      } finally {
        clearTurnState(state);
        state.currentSessionFile = undefined;
        state.currentCwd = undefined;
      }
    },
  };
}

function attachSession(
  state: SessionHookState,
  sessionFile: string | undefined,
  cwd: string,
): void {
  if (sessionFile !== undefined) {
    state.currentSessionFile = sessionFile;
  }

  state.currentCwd = cwd;
}

function syncAttachedSession(
  indexPath: string,
  state: SessionHookState,
  eventType: string,
  sessionOrigin?: SessionOrigin,
): boolean {
  return syncSessionFile(indexPath, state.currentSessionFile, eventType, state, sessionOrigin);
}

function syncSessionFile(
  indexPath: string,
  sessionFile: string | undefined,
  eventType: string,
  state?: SessionHookState,
  sessionOrigin?: SessionOrigin,
): boolean {
  if (!sessionFile || !existsSync(sessionFile) || !existsSync(indexPath)) {
    return false;
  }

  const db = openIndexDatabase(indexPath, { create: false });
  try {
    if (readIndexSchemaVersion(db) !== INDEX_SCHEMA_VERSION) {
      return false;
    }

    const synced = syncSessionFileWithDb(db, sessionFile, eventType, sessionOrigin);
    if (synced && state) {
      state.lastFlushedSessionFile = sessionFile;
    }
    return synced;
  } finally {
    db.close();
  }
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
    db.transaction(() => writeHookSyncMetadata(db, eventType)).immediate();
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

// All write transactions are immediate: they read before they write, and a
// deferred transaction whose snapshot goes stale fails with SQLITE_BUSY on the
// read-to-write upgrade without ever invoking the busy handler. Immediate mode
// takes the write lock at BEGIN, where busy_timeout queues us behind concurrent
// writers from other pi processes.
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
  }).immediate();
}

function applyTailSync(
  db: SessionIndexDatabase,
  baseline: TailSyncBaseline,
  tail: ExtractedSessionTail,
  eventType: string,
  sessionOrigin?: SessionOrigin,
): boolean {
  return db
    .transaction((): boolean => {
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
        if (scan.sessionName) {
          insertTextChunk(db, {
            sessionId: baseline.sessionId,
            ...createSessionNameChunk(scan.sessionName, baseline.startedAt),
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
        insertTextChunk(db, {
          sessionId: baseline.sessionId,
          entryId,
          entryType: "custom",
          ts,
          sourceKind: "handoff_next_task",
          text: metadata.nextTask,
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
    })
    .immediate();
}

function buildTailSessionRow(
  baseline: TailSyncBaseline,
  tail: ExtractedSessionTail,
  sessionOrigin?: SessionOrigin,
): SessionRow {
  const scan = tail.scan;
  const tailHandoffMetadata = baseline.handoffGoal ? undefined : scan.handoffMetadata?.metadata;
  const tailOrigin =
    baseline.parentSessionPath && tailHandoffMetadata?.origin === "handoff"
      ? ("handoff" as const)
      : undefined;
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
    handoffNextTask: baseline.handoffNextTask ?? tailHandoffMetadata?.nextTask,
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

function readIndexSchemaVersion(db: SessionIndexDatabase): number | undefined {
  const raw = getMetadata(db, "schema_version");
  return raw === undefined ? undefined : Number(raw);
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

function buildPendingToolCall(event: ToolCallEvent): PendingToolCall | undefined {
  if (isToolCallEventType("read", event)) {
    return buildTrackedToolCall(event.toolCallId, "read", event.input.path);
  }

  if (isToolCallEventType("edit", event)) {
    return buildTrackedToolCall(event.toolCallId, "edit", event.input.path);
  }

  if (isToolCallEventType("write", event)) {
    return buildTrackedToolCall(event.toolCallId, "write", event.input.path);
  }

  return undefined;
}

function buildTrackedToolCall(
  toolCallId: string,
  toolName: TrackedToolName,
  rawPath: string,
): PendingToolCall | undefined {
  const path = stringValue(rawPath);
  if (!path) {
    return undefined;
  }

  return {
    toolCallId,
    toolName,
    path,
  };
}

function summarizeToolResultText(
  toolName: string,
  content: Array<TextContent | ImageContent>,
): string {
  const text = content
    .filter((part): part is TextContent => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();

  if (toolName === "write") {
    return text;
  }

  return truncateText(text, TOOL_RESULT_TEXT_LIMIT);
}

function truncateText(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }

  return `${text.slice(0, limit)}…`;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function clearTurnState(state: SessionHookState): void {
  state.pendingToolCalls.clear();
  state.finalizedToolCalls.clear();
}
