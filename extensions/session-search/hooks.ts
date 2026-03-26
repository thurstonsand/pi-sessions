import { existsSync } from "node:fs";
import type { ToolCallEvent, ToolResultEvent } from "@mariozechner/pi-coding-agent";
import {
  clearSessionIndexedData,
  getDefaultIndexPath,
  getIndexStatus,
  getSessionById,
  INDEX_SCHEMA_VERSION,
  insertSessionFileTouch,
  insertTextChunk,
  openIndexDatabase,
  rebuildSessionLineageRelations,
  type SessionLineageRow,
  type SessionOrigin,
  setMetadata,
  upsertSession,
} from "./db.js";
import { type ExtractedSessionRecord, extractSessionRecord } from "./extract.js";

const TOOL_RESULT_TEXT_LIMIT = 500;

const pendingChildOrigins = new Map<string, SessionOrigin[]>();

export function queuePendingChildOrigin(
  parentSessionPath: string,
  sessionOrigin: SessionOrigin,
): void {
  const queue = pendingChildOrigins.get(parentSessionPath) ?? [];
  queue.push(sessionOrigin);
  pendingChildOrigins.set(parentSessionPath, queue);
}

export function clearPendingChildOrigin(parentSessionPath: string): void {
  pendingChildOrigins.delete(parentSessionPath);
}

export function consumePendingChildOrigin(parentSessionPath: string): SessionOrigin | undefined {
  const queue = pendingChildOrigins.get(parentSessionPath);
  if (!queue || queue.length === 0) {
    return undefined;
  }

  const sessionOrigin = queue.shift();
  if (queue.length === 0) {
    pendingChildOrigins.delete(parentSessionPath);
  }

  return sessionOrigin;
}

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

export function createSessionHookController(options?: {
  indexPath?: string;
}): SessionHookController {
  const indexPath = options?.indexPath ?? getDefaultIndexPath();
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
      const synced = syncAttachedSession(indexPath, state, "turn_end");
      clearTurnState(state);
      return synced;
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
      const synced = syncAttachedSession(indexPath, state, "session_shutdown");
      clearTurnState(state);
      state.currentSessionFile = undefined;
      state.currentCwd = undefined;
      return synced;
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
  if (!sessionFile || !existsSync(sessionFile)) {
    return false;
  }

  const status = getIndexStatus(indexPath);
  if (!status.exists || status.schemaVersion !== INDEX_SCHEMA_VERSION) {
    return false;
  }

  const extracted = extractSessionRecord(sessionFile);
  if (!extracted) {
    return false;
  }

  const db = openIndexDatabase(indexPath, { create: false });
  try {
    db.transaction(() => {
      const existingSession = getSessionById(db, extracted.sessionId);
      const sessionRow = mergeSessionLineage(extracted, existingSession, sessionOrigin);
      upsertSession(db, sessionRow, "hook");
      if (shouldRefreshLineageRelations(existingSession, sessionRow)) {
        rebuildSessionLineageRelations(db);
      }
      clearSessionIndexedData(db, extracted.sessionId);

      for (const chunk of extracted.chunks) {
        insertTextChunk(db, { sessionId: extracted.sessionId, ...chunk });
      }

      for (const fileTouch of extracted.fileTouches) {
        insertSessionFileTouch(db, { sessionId: extracted.sessionId, ...fileTouch });
      }

      setMetadata(db, "hook_updated_at", new Date().toISOString());
      setMetadata(db, "hook_last_event", eventType);
    })();
  } finally {
    db.close();
  }

  if (state) {
    state.lastFlushedSessionFile = sessionFile;
  }

  return true;
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
  switch (event.toolName) {
    case "read":
    case "edit":
    case "write": {
      const path = stringValue(event.input.path);
      if (!path) {
        return undefined;
      }

      return {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        path,
      };
    }
    default:
      return undefined;
  }
}

function summarizeToolResultText(toolName: string, content: ToolResultEvent["content"]): string {
  const text = content
    .filter((part): part is { type: "text"; text: string } => {
      return part.type === "text" && typeof part.text === "string";
    })
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
