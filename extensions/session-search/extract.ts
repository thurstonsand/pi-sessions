import {
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
} from "node:fs";
import path from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolCall } from "@earendil-works/pi-ai";
import {
  type CustomEntry,
  parseSessionEntries,
  type SessionEntry,
  type SessionHeader,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  HANDOFF_METADATA_CUSTOM_TYPE,
  type HandoffSessionMetadata,
  parseHandoffSessionMetadata,
} from "../session-handoff/metadata.ts";
import type { SessionOrigin } from "../shared/session-index/index.ts";
import { contentToText, isRecord } from "../shared/text.ts";
import { safeParseTypeBoxValue } from "../shared/typebox.ts";
import { SUBAGENT_LAUNCHED_CUSTOM_TYPE, SUBAGENT_LAUNCHED_SCHEMA } from "../subagents/ledger.ts";
import {
  deriveSessionRepoRoots,
  type FileTouchOp,
  type FileTouchSource,
  normalizePathRecord,
  type PathScope,
} from "./normalize.ts";

export interface SearchTextChunk {
  entryId: string;
  entryType: string;
  role?: string | undefined;
  ts: string;
  sourceKind: string;
  text: string;
}

export interface DurableHandoffMetadataRecord {
  entryId: string;
  ts: string;
  metadata: HandoffSessionMetadata;
}

export interface SessionFileTouch {
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

export interface ExtractedSessionRecord {
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
  indexedFileSize: number;
  indexedFileMtimeMs: number;
  indexedFileAnchor: string;
  chunks: SearchTextChunk[];
  fileTouches: SessionFileTouch[];
}

export interface SessionEntryScan {
  chunks: SearchTextChunk[];
  fileTouches: SessionFileTouch[];
  messageCount: number;
  entryCount: number;
  maxEntryTs?: string | undefined;
  firstUserPrompt?: string | undefined;
  sessionName?: string | undefined;
  sessionNameEntryId?: string | undefined;
  sessionNameTs?: string | undefined;
  handoffMetadata?: DurableHandoffMetadataRecord | undefined;
}

export interface SessionTailBaseline {
  sessionId: string;
  cwd: string;
  startedAt: string;
  indexedFileSize: number;
  indexedFileAnchor: string;
}

export interface ExtractedSessionTail {
  scan: SessionEntryScan;
  indexedFileSize: number;
  indexedFileMtimeMs: number;
  indexedFileAnchor: string;
}

export interface ParsedSessionFile {
  header: SessionHeader;
  entries: SessionEntry[];
  sessionName: string;
}

const TOOL_RESULT_TEXT_LIMIT = 500;
const TOOL_CALL_TEXT_LIMIT = 2_000;
const BASH_OUTPUT_TEXT_LIMIT = 500;
const FILE_ANCHOR_BYTES = 64;
const NEWLINE_BYTE = 0x0a;
const SUMMARY_DETAILS_SCHEMA = Type.Object({
  readFiles: Type.Optional(Type.Array(Type.String())),
  modifiedFiles: Type.Optional(Type.Array(Type.String())),
});

export function listSessionFiles(sessionsDir: string): string[] {
  if (!existsSync(sessionsDir)) {
    return [];
  }

  const results: string[] = [];
  const stack = [sessionsDir];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;

    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(absolute);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        results.push(absolute);
      }
    }
  }

  return results.sort();
}

export function extractSessionRecord(sessionPath: string): ExtractedSessionRecord | undefined {
  const indexedFileMtimeMs = Math.trunc(statSync(sessionPath).mtimeMs);
  const buffer = readFileSync(sessionPath);
  const slice = sliceCompleteJsonlPrefix(buffer);
  const parsed = parseSessionContent(slice.content);
  if (!parsed) return undefined;

  const fallbackTs = parsed.header.timestamp;
  const scan = scanSessionEntries(parsed.entries, fallbackTs, parsed.header.cwd);

  const chunks: SearchTextChunk[] = [];
  if (parsed.sessionName && scan.sessionNameEntryId) {
    chunks.push(
      createSessionNameChunk(
        parsed.sessionName,
        scan.sessionNameTs ?? fallbackTs,
        scan.sessionNameEntryId,
      ),
    );
  }
  chunks.push(...scan.chunks);
  appendDurableHandoffMetadataChunks(chunks, scan.handoffMetadata);

  const parentSessionPath = normalizeParentSessionPath(parsed.header.parentSession);
  const parentSession = parentSessionPath
    ? inspectParentSession(parentSessionPath, parsed.header.id, sessionPath)
    : undefined;

  return {
    sessionId: parsed.header.id,
    sessionPath,
    sessionName: parsed.sessionName,
    firstUserPrompt: trimmedText(scan.firstUserPrompt),
    cwd: parsed.header.cwd,
    repoRoots: deriveSessionRepoRoots(parsed.header.cwd, scan.fileTouches),
    startedAt: fallbackTs,
    modifiedAt: maxTimestamp(fallbackTs, scan.maxEntryTs),
    messageCount: scan.messageCount,
    entryCount: scan.entryCount,
    parentSessionPath,
    parentSessionId: parentSession?.sessionId,
    sessionOrigin: deriveSessionOrigin(
      parentSessionPath,
      parentSession?.launchedSubagent ?? false,
      scan.handoffMetadata?.metadata,
    ),
    handoffGoal: scan.handoffMetadata?.metadata.goal,
    handoffNextTask: scan.handoffMetadata?.metadata.nextTask,
    indexedFileSize: slice.consumedBytes,
    indexedFileMtimeMs,
    indexedFileAnchor: buildFileAnchor(buffer, slice.consumedBytes),
    chunks: chunks,
    fileTouches: scan.fileTouches,
  };
}

// Reads only the bytes appended since the last sync. The stored anchor (the
// final bytes of the previously indexed prefix) proves the prefix is unchanged;
// any in-place rewrite invalidates it and the caller falls back to a full
// re-extract. Session files are append-only in normal pi operation.
export function extractSessionTail(
  sessionPath: string,
  baseline: SessionTailBaseline,
): ExtractedSessionTail | undefined {
  const anchorBytes = Buffer.from(baseline.indexedFileAnchor, "base64");
  const anchorStart = baseline.indexedFileSize - anchorBytes.length;
  if (anchorBytes.length === 0 || anchorStart < 0) {
    return undefined;
  }

  const indexedFileMtimeMs = Math.trunc(statSync(sessionPath).mtimeMs);
  const fd = openSync(sessionPath, "r");
  try {
    const fileSize = fstatSync(fd).size;
    if (fileSize < baseline.indexedFileSize) {
      return undefined;
    }

    const window = Buffer.alloc(fileSize - anchorStart);
    const bytesRead = readSync(fd, window, 0, window.length, anchorStart);
    if (
      bytesRead < anchorBytes.length ||
      !window.subarray(0, anchorBytes.length).equals(anchorBytes)
    ) {
      return undefined;
    }

    const tailBuffer = window.subarray(anchorBytes.length, bytesRead);
    const slice = sliceCompleteJsonlPrefix(tailBuffer);
    const entries = parseSessionEntries(slice.content).filter(isSessionEntry);
    const consumedWindow = Buffer.concat([
      anchorBytes,
      tailBuffer.subarray(0, slice.consumedBytes),
    ]);

    return {
      scan: scanSessionEntries(entries, baseline.startedAt, baseline.cwd),
      indexedFileSize: baseline.indexedFileSize + slice.consumedBytes,
      indexedFileMtimeMs,
      indexedFileAnchor: buildFileAnchor(consumedWindow, consumedWindow.length),
    };
  } finally {
    closeSync(fd);
  }
}

export function createSessionNameChunk(
  sessionName: string,
  ts: string,
  entryId: string,
): SearchTextChunk {
  return {
    entryId,
    entryType: "session_info",
    ts,
    sourceKind: "session_name",
    text: sessionName,
  };
}

export function scanSessionEntries(
  entries: SessionEntry[],
  fallbackTs: string,
  cwd: string,
): SessionEntryScan {
  const chunks: SearchTextChunk[] = [];
  const fileTouches: SessionFileTouch[] = [];
  let messageCount = 0;
  let maxEntryTs: string | undefined;
  let firstUserPrompt: string | undefined;
  let sessionName: string | undefined;
  let sessionNameEntryId: string | undefined;
  let sessionNameTs: string | undefined;
  let handoffMetadata: DurableHandoffMetadataRecord | undefined;

  for (const entry of entries) {
    const entryTs = getEntryTimestamp(entry, fallbackTs);
    if (maxEntryTs === undefined || entryTs > maxEntryTs) {
      maxEntryTs = entryTs;
    }

    switch (entry.type) {
      case "message": {
        const { message } = entry;

        messageCount += 1;
        if (!firstUserPrompt && message.role === "user") {
          firstUserPrompt = contentToText(message.content);
        }
        chunks.push(...extractMessageChunks(entry.id, entryTs, message));
        fileTouches.push(...extractMessageFileTouches(entry.id, entryTs, message, cwd));
        continue;
      }
      case "session_info": {
        if (typeof entry.name === "string") {
          sessionName = entry.name.trim();
          sessionNameEntryId = entry.id;
          sessionNameTs = entryTs;
        }
        continue;
      }
      case "custom": {
        const nextHandoffMetadata = extractHandoffMetadata(entry, entryTs);
        if (nextHandoffMetadata && !handoffMetadata) {
          handoffMetadata = nextHandoffMetadata;
        }
        continue;
      }
      case "custom_message":
        appendEntryTextChunk(
          chunks,
          entry,
          entryTs,
          "custom_message",
          contentToText(entry.content),
        );
        continue;
      case "branch_summary": {
        appendEntryTextChunk(chunks, entry, entryTs, "branch_summary", trimmedText(entry.summary));
        fileTouches.push(
          ...extractDetailFileTouches(
            entry.id,
            entryTs,
            "branch_summary_details",
            entry.details,
            cwd,
          ),
        );
        continue;
      }
      case "compaction": {
        appendEntryTextChunk(
          chunks,
          entry,
          entryTs,
          "compaction_summary",
          trimmedText(entry.summary),
        );
        fileTouches.push(
          ...extractDetailFileTouches(entry.id, entryTs, "compaction_details", entry.details, cwd),
        );
        continue;
      }
      default:
        continue;
    }
  }

  return {
    chunks,
    fileTouches,
    messageCount,
    entryCount: entries.length,
    maxEntryTs,
    firstUserPrompt,
    sessionName,
    sessionNameEntryId,
    sessionNameTs,
    handoffMetadata,
  };
}

function maxTimestamp(fallbackTs: string, entryTs: string | undefined): string {
  return entryTs !== undefined && entryTs > fallbackTs ? entryTs : fallbackTs;
}

// Consumes only whole JSONL lines so the recorded byte offset always lands on
// an entry boundary. A final unterminated line is consumed only if it parses as
// complete JSON: a strict prefix of a JSON object can never parse, so a torn
// in-progress write is reliably excluded.
function sliceCompleteJsonlPrefix(buffer: Buffer): { content: string; consumedBytes: number } {
  if (buffer.length === 0) {
    return { content: "", consumedBytes: 0 };
  }

  if (buffer[buffer.length - 1] === NEWLINE_BYTE) {
    return { content: buffer.toString("utf8"), consumedBytes: buffer.length };
  }

  const lastNewline = buffer.lastIndexOf(NEWLINE_BYTE);
  const finalLine = buffer.subarray(lastNewline + 1).toString("utf8");
  if (isCompleteJsonLine(finalLine)) {
    return { content: buffer.toString("utf8"), consumedBytes: buffer.length };
  }

  const consumedBytes = lastNewline + 1;
  return { content: buffer.subarray(0, consumedBytes).toString("utf8"), consumedBytes };
}

function isCompleteJsonLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) {
    return true;
  }

  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

function buildFileAnchor(buffer: Buffer, end: number): string {
  const start = Math.max(0, end - FILE_ANCHOR_BYTES);
  return buffer.subarray(start, end).toString("base64");
}

export function parseSessionFile(sessionPath: string): ParsedSessionFile | undefined {
  return parseSessionContent(readFileSync(sessionPath, "utf8"));
}

export function parseSessionContent(raw: string): ParsedSessionFile | undefined {
  const fileEntries = parseSessionEntries(raw);
  if (fileEntries.length === 0) {
    return undefined;
  }

  const header = fileEntries[0];
  if (header?.type !== "session") {
    return undefined;
  }

  const entries = fileEntries.slice(1).filter(isSessionEntry);

  let sessionName = "";
  for (const entry of entries) {
    if (entry.type !== "session_info") {
      continue;
    }

    if (typeof entry.name === "string") {
      sessionName = entry.name.trim();
    }
  }

  return { header, entries, sessionName };
}

function normalizeParentSessionPath(parentSession: string | undefined): string | undefined {
  if (typeof parentSession !== "string") {
    return undefined;
  }

  const trimmed = parentSession.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

interface ParentSessionInspection {
  sessionId: string;
  launchedSubagent: boolean;
}

export function inferSessionOrigin(
  sessionId: string,
  sessionPath: string,
  parentSessionPath: string | undefined,
  handoffMetadata: HandoffSessionMetadata | undefined,
): SessionOrigin | undefined {
  const parentSession = parentSessionPath
    ? inspectParentSession(parentSessionPath, sessionId, sessionPath)
    : undefined;
  return deriveSessionOrigin(
    parentSessionPath,
    parentSession?.launchedSubagent ?? false,
    handoffMetadata,
  );
}

function inspectParentSession(
  parentSessionPath: string,
  childSessionId: string,
  childSessionPath: string,
): ParentSessionInspection | undefined {
  try {
    const parent = parseSessionFile(parentSessionPath);
    if (!parent) {
      return undefined;
    }

    const launchedSubagent = parent.entries.some((entry) => {
      if (entry.type !== "custom" || entry.customType !== SUBAGENT_LAUNCHED_CUSTOM_TYPE) {
        return false;
      }
      const launch = safeParseTypeBoxValue(SUBAGENT_LAUNCHED_SCHEMA, entry.data);
      return (
        launch?.writerSessionId === parent.header.id &&
        launch.childSessionId === childSessionId &&
        launch.childSessionFile === childSessionPath
      );
    });
    return { sessionId: parent.header.id, launchedSubagent };
  } catch {
    return undefined;
  }
}

function deriveSessionOrigin(
  parentSessionPath: string | undefined,
  launchedSubagent: boolean,
  handoffMetadata: HandoffSessionMetadata | undefined,
): SessionOrigin | undefined {
  if (!parentSessionPath) {
    return undefined;
  }
  if (launchedSubagent) {
    return "subagent";
  }
  return handoffMetadata?.origin === "handoff" ? "handoff" : "unknown_child";
}

function extractHandoffMetadata(
  entry: CustomEntry,
  ts: string,
): DurableHandoffMetadataRecord | undefined {
  if (entry.customType !== HANDOFF_METADATA_CUSTOM_TYPE) {
    return undefined;
  }

  const metadata = parseHandoffSessionMetadata(entry.data);
  if (!metadata) {
    return undefined;
  }

  return {
    entryId: entry.id,
    ts,
    metadata,
  };
}

function appendDurableHandoffMetadataChunks(
  chunks: SearchTextChunk[],
  durableHandoffMetadata: DurableHandoffMetadataRecord | undefined,
): void {
  if (!durableHandoffMetadata) {
    return;
  }

  const { entryId, ts, metadata } = durableHandoffMetadata;
  chunks.push(
    createMetadataChunk(entryId, ts, "handoff_goal", metadata.goal),
    createMetadataChunk(entryId, ts, "handoff_next_task", metadata.nextTask),
  );
}

function createMetadataChunk(
  entryId: string,
  ts: string,
  sourceKind: string,
  text: string,
): SearchTextChunk {
  return {
    entryId,
    entryType: "custom",
    ts,
    sourceKind,
    text,
  };
}

function getEntryTimestamp(entry: SessionEntry, fallbackTs: string): string {
  return entry.timestamp ?? fallbackTs;
}

function appendEntryTextChunk(
  chunks: SearchTextChunk[],
  entry: SessionEntry,
  ts: string,
  sourceKind: string,
  text: string,
): void {
  if (!text) {
    return;
  }

  chunks.push({
    entryId: entry.id,
    entryType: entry.type,
    ts,
    sourceKind,
    text,
  });
}

function extractMessageFileTouches(
  entryId: string | undefined,
  ts: string,
  message: AgentMessage,
  cwd: string,
): SessionFileTouch[] {
  if (message.role !== "assistant" || !Array.isArray(message.content)) {
    return [];
  }

  return message.content.filter(isToolCallBlock).flatMap((toolCall) => {
    const rawPath = stringValue(toolCall.arguments?.path);
    const op = getToolCallFileTouchOp(toolCall.name);
    if (!rawPath || !op) {
      return [];
    }

    return [createFileTouch(entryId, ts, op, "tool_call", rawPath, cwd)];
  });
}

function extractDetailFileTouches(
  entryId: string | undefined,
  ts: string,
  source: FileTouchSource,
  details: unknown,
  cwd: string,
): SessionFileTouch[] {
  const normalizedDetails = getSummaryDetails(details);
  if (!normalizedDetails) {
    return [];
  }

  return [
    ...extractDetailFileTouchGroup(entryId, ts, source, "read", normalizedDetails.readFiles, cwd),
    ...extractDetailFileTouchGroup(
      entryId,
      ts,
      source,
      "changed",
      normalizedDetails.modifiedFiles,
      cwd,
    ),
  ];
}

function extractDetailFileTouchGroup(
  entryId: string | undefined,
  ts: string,
  source: FileTouchSource,
  op: FileTouchOp,
  paths: unknown,
  cwd: string,
): SessionFileTouch[] {
  if (!Array.isArray(paths)) {
    return [];
  }

  return paths
    .filter(
      (rawPath): rawPath is string => typeof rawPath === "string" && rawPath.trim().length > 0,
    )
    .map((rawPath) => createFileTouch(entryId, ts, op, source, rawPath, cwd));
}

function createFileTouch(
  entryId: string | undefined,
  ts: string,
  op: FileTouchOp,
  source: FileTouchSource,
  rawPath: string,
  cwd: string,
): SessionFileTouch {
  return {
    entryId,
    source,
    ...normalizePathRecord(rawPath, cwd),
    op,
    ts,
  };
}

function getAssistantToolCalls(content: unknown): ToolCallBlock[] {
  if (!Array.isArray(content)) {
    return [];
  }

  return content.filter(isToolCallBlock);
}

function isToolCallBlock(part: unknown): part is ToolCallBlock {
  return (
    isRecord(part) &&
    part.type === "toolCall" &&
    typeof part.id === "string" &&
    typeof part.name === "string" &&
    isRecord(part.arguments)
  );
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function getToolCallFileTouchOp(toolName: string): FileTouchOp | undefined {
  switch (toolName) {
    case "read":
      return "read";
    case "edit":
    case "write":
      return "changed";
    default:
      return undefined;
  }
}

function trimmedText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function truncateText(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }
  return `${text.slice(0, limit)}…`;
}

function extractMessageChunks(
  entryId: string,
  fallbackTs: string,
  message: AgentMessage,
): SearchTextChunk[] {
  const ts = message.timestamp ? new Date(message.timestamp).toISOString() : fallbackTs;

  switch (message.role) {
    case "user": {
      return buildOptionalMessageChunk(
        entryId,
        "user",
        ts,
        "user_text",
        contentToText(message.content),
      );
    }
    case "assistant": {
      return [
        ...buildOptionalMessageChunk(
          entryId,
          "assistant",
          ts,
          "assistant_text",
          contentToText(message.content),
        ),
        ...extractToolCallChunks(entryId, ts, message),
      ];
    }
    case "toolResult": {
      return buildOptionalMessageChunk(
        entryId,
        "toolResult",
        ts,
        "tool_result",
        truncateText(contentToText(message.content), TOOL_RESULT_TEXT_LIMIT),
      );
    }
    case "bashExecution": {
      const chunks: SearchTextChunk[] = [];

      if (message.command) {
        chunks.push(
          createMessageChunk(entryId, "bashExecution", ts, "bash_command", message.command),
        );
      }

      const output = message.output ? truncateText(message.output, BASH_OUTPUT_TEXT_LIMIT) : "";
      if (output) {
        chunks.push(createMessageChunk(entryId, "bashExecution", ts, "bash_output", output));
      }

      return chunks;
    }
    case "custom": {
      return buildOptionalMessageChunk(
        entryId,
        "custom",
        ts,
        "custom_message",
        contentToText(message.content),
      );
    }
    default:
      return [];
  }
}

function extractToolCallChunks(
  entryId: string,
  ts: string,
  message: AssistantMessage,
): SearchTextChunk[] {
  return getAssistantToolCalls(message.content).map((toolCall) =>
    createMessageChunk(
      entryId,
      "assistant",
      ts,
      "tool_call",
      truncateText(
        `${toolCall.name} ${JSON.stringify(toolCall.arguments ?? {})}`,
        TOOL_CALL_TEXT_LIMIT,
      ),
    ),
  );
}

function createMessageChunk(
  entryId: string,
  role: string,
  ts: string,
  sourceKind: string,
  text: string,
): SearchTextChunk {
  return {
    entryId,
    entryType: "message",
    role,
    ts,
    sourceKind,
    text,
  };
}

function buildOptionalMessageChunk(
  entryId: string,
  role: string,
  ts: string,
  sourceKind: string,
  text: string,
): SearchTextChunk[] {
  if (!text) {
    return [];
  }

  return [createMessageChunk(entryId, role, ts, sourceKind, text)];
}

interface SummaryDetails {
  readFiles?: unknown;
  modifiedFiles?: unknown;
}

type ToolCallBlock = ToolCall & {
  arguments: Record<string, unknown>;
};

function isSessionEntry(entry: SessionHeader | SessionEntry): entry is SessionEntry {
  return entry.type !== "session";
}

function getSummaryDetails(details: unknown): SummaryDetails | undefined {
  return safeParseTypeBoxValue(SUMMARY_DETAILS_SCHEMA, details);
}
