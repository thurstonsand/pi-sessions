import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, ToolCall, ToolResultMessage } from "@mariozechner/pi-ai";
import {
  type CustomEntry,
  parseSessionEntries,
  type SessionEntry,
  type SessionHeader,
  type SessionMessageEntry,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
  HANDOFF_METADATA_CUSTOM_TYPE,
  type HandoffSessionMetadata,
  parseHandoffSessionMetadata,
} from "../session-handoff/metadata.js";
import type { SessionOrigin } from "../shared/session-index/index.js";
import { safeParseTypeBoxValue } from "../shared/typebox.js";
import {
  deriveSessionRepoRoots,
  type FileTouchOp,
  type FileTouchSource,
  normalizePathRecord,
  type PathScope,
} from "./normalize.js";

export interface SearchTextChunk {
  entryId?: string | undefined;
  entryType: string;
  role?: string | undefined;
  ts: string;
  sourceKind: string;
  text: string;
}

interface DurableHandoffMetadataRecord {
  entryId?: string | undefined;
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
  chunks: SearchTextChunk[];
  fileTouches: SessionFileTouch[];
}

export interface ParsedSessionFile {
  header: SessionHeader;
  entries: SessionEntry[];
  sessionName: string;
}

const TOOL_RESULT_TEXT_LIMIT = 500;
const BASH_OUTPUT_TEXT_LIMIT = 500;
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
  const parsed = parseSessionFile(sessionPath);
  if (!parsed) return undefined;

  const fallbackTs = parsed.header.timestamp;
  const chunks: SearchTextChunk[] = [];
  const fileTouches: SessionFileTouch[] = [];
  let modifiedAt = fallbackTs;
  let messageCount = 0;
  let firstUserPrompt: string | undefined;
  let durableHandoffMetadata: DurableHandoffMetadataRecord | undefined;

  if (parsed.sessionName) {
    chunks.push({
      entryType: "session_info",
      ts: parsed.header.timestamp,
      sourceKind: "session_name",
      text: parsed.sessionName,
    });
  }

  for (const entry of parsed.entries) {
    const entryTs = getEntryTimestamp(entry, fallbackTs);
    if (entryTs > modifiedAt) {
      modifiedAt = entryTs;
    }

    switch (entry.type) {
      case "message": {
        const { message } = entry;

        messageCount += 1;
        if (!firstUserPrompt && message.role === "user") {
          firstUserPrompt = contentToText(message.content);
        }
        chunks.push(...extractMessageChunks(entry.id, entryTs, message));
        fileTouches.push(
          ...extractMessageFileTouches(entry.id, entryTs, message, parsed.header.cwd),
        );
        continue;
      }
      case "custom": {
        const nextHandoffMetadata = extractHandoffMetadata(entry, entryTs);
        if (nextHandoffMetadata) {
          durableHandoffMetadata = nextHandoffMetadata;
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
            parsed.header.cwd,
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
          ...extractDetailFileTouches(
            entry.id,
            entryTs,
            "compaction_details",
            entry.details,
            parsed.header.cwd,
          ),
        );
        continue;
      }
      default:
        continue;
    }
  }

  appendDurableHandoffMetadataChunks(chunks, durableHandoffMetadata);

  const parentSessionPath = normalizeParentSessionPath(parsed.header.parentSession);

  return {
    sessionId: parsed.header.id,
    sessionPath,
    sessionName: parsed.sessionName,
    firstUserPrompt: trimmedText(firstUserPrompt),
    cwd: parsed.header.cwd,
    repoRoots: deriveSessionRepoRoots(parsed.header.cwd, fileTouches),
    startedAt: parsed.header.timestamp,
    modifiedAt,
    messageCount,
    entryCount: parsed.entries.length,
    parentSessionPath,
    parentSessionId: parentSessionPath ? readSessionIdFromPath(parentSessionPath) : undefined,
    sessionOrigin: inferSessionOrigin(parentSessionPath, durableHandoffMetadata?.metadata),
    handoffGoal: durableHandoffMetadata?.metadata.goal,
    handoffNextTask: durableHandoffMetadata?.metadata.nextTask,
    chunks,
    fileTouches,
  };
}

export function parseSessionFile(sessionPath: string): ParsedSessionFile | undefined {
  const raw = readFileSync(sessionPath, "utf8");
  const fileEntries = parseSessionEntries(raw);
  if (fileEntries.length === 0) {
    return undefined;
  }

  const header = fileEntries[0];
  if (!header || header.type !== "session") {
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

function findDurableHandoffMetadata(
  entries: SessionEntry[],
  fallbackTs: string,
): DurableHandoffMetadataRecord | undefined {
  let durableHandoffMetadata: DurableHandoffMetadataRecord | undefined;

  for (const entry of entries) {
    if (entry.type !== "custom") {
      continue;
    }

    const parsed = extractHandoffMetadata(entry, getEntryTimestamp(entry, fallbackTs));
    if (parsed) {
      durableHandoffMetadata = parsed;
    }
  }

  return durableHandoffMetadata;
}

function readSessionIdFromPath(sessionPath: string): string | undefined {
  try {
    const parsed = parseSessionFile(sessionPath);
    return parsed?.header.id;
  } catch {
    return undefined;
  }
}

function inferSessionOrigin(
  parentSessionPath: string | undefined,
  handoffMetadata: HandoffSessionMetadata | undefined,
): SessionOrigin | undefined {
  if (!parentSessionPath) {
    return undefined;
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
  entryId: string | undefined,
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

function groupEntriesByParent(entries: SessionEntry[]): Map<string | null, SessionEntry[]> {
  const byParent = new Map<string | null, SessionEntry[]>();

  for (const entry of entries) {
    const parentId = entry.parentId ?? null;
    const bucket = byParent.get(parentId);
    if (bucket) {
      bucket.push(entry);
      continue;
    }

    byParent.set(parentId, [entry]);
  }

  for (const childEntries of byParent.values()) {
    childEntries.sort((a, b) => (a.timestamp ?? "").localeCompare(b.timestamp ?? ""));
  }

  return byParent;
}

function buildSessionTreeHeader(parsed: ParsedSessionFile, sessionPath: string): string[] {
  const durableHandoffMetadata = findDurableHandoffMetadata(
    parsed.entries,
    parsed.header.timestamp,
  );
  const lines = [
    `# Session ${parsed.sessionName || parsed.header.id}`,
    "",
    `- session_id: ${parsed.header.id}`,
    `- session_path: ${sessionPath}`,
    `- cwd: ${parsed.header.cwd}`,
    `- started_at: ${parsed.header.timestamp}`,
  ];

  if (parsed.header.parentSession) {
    lines.push(`- parent_session: ${parsed.header.parentSession}`);
  }

  if (durableHandoffMetadata) {
    lines.push(
      `- session_origin: ${durableHandoffMetadata.metadata.origin}`,
      `- handoff_goal: ${durableHandoffMetadata.metadata.goal}`,
      `- handoff_next_task: ${durableHandoffMetadata.metadata.nextTask}`,
    );
  }

  lines.push("", "## Session Tree", "");
  return lines;
}

export interface RenderedSessionTree {
  markdown: string;
  sessionId: string;
  sessionName: string;
}

export function renderSessionTreeMarkdown(
  sessionPath: string,
  options?: { maxChars?: number },
): RenderedSessionTree {
  const parsed = parseSessionFile(sessionPath);
  if (!parsed) {
    throw new Error(`Unable to parse session file: ${sessionPath}`);
  }

  const byParent = groupEntriesByParent(parsed.entries);
  const lines = buildSessionTreeHeader(parsed, sessionPath);

  const roots = byParent.get(null) ?? [];
  for (const root of roots) {
    renderTreeSegment(root, byParent, lines);
  }

  const markdown = lines.join("\n");
  const maxChars = options?.maxChars;
  if (maxChars === undefined || markdown.length <= maxChars) {
    return { markdown, sessionId: parsed.header.id, sessionName: parsed.sessionName };
  }

  return {
    markdown: `${markdown.slice(0, maxChars)}\n\n[session tree truncated to ${maxChars} characters]`,
    sessionId: parsed.header.id,
    sessionName: parsed.sessionName,
  };
}

function renderTreeSegment(
  start: SessionEntry,
  byParent: Map<string | null, SessionEntry[]>,
  lines: string[],
  depth = 0,
): void {
  let current: SessionEntry | undefined = start;

  while (current) {
    appendEntryLines(lines, describeEntry(current, byParent), depth);

    const children = getRenderableChildren(current, byParent);
    if (children.length === 0) {
      return;
    }

    if (children.length === 1) {
      current = children[0];
      continue;
    }

    lines.push(`${"  ".repeat(depth)}  branches:`);
    for (const child of children) {
      renderTreeSegment(child, byParent, lines, depth + 1);
    }
    return;
  }
}

function appendEntryLines(lines: string[], entryLines: string[], depth: number): void {
  if (entryLines.length === 0) return;

  const indent = "  ".repeat(depth);
  lines.push(`${indent}- ${entryLines[0]}`);
  for (let i = 1; i < entryLines.length; i++) {
    lines.push(`${indent}  ${entryLines[i]}`);
  }
}

function describeEntry(
  entry: SessionEntry,
  byParent: Map<string | null, SessionEntry[]>,
): string[] {
  switch (entry.type) {
    case "message":
      return describeMessageEntry(entry, byParent);
    case "branch_summary":
      return [describeLabeledText("Branch summary", entry.summary, 220)];
    case "compaction":
      return [describeLabeledText("Compaction summary", entry.summary, 220)];
    case "session_info":
      return [describeLabeledText("Session name", entry.name, 180)];
    case "model_change":
      return [`Model: ${entry.provider}/${entry.modelId}`];
    case "thinking_level_change":
      return [`Thinking: ${entry.thinkingLevel}`];
    default:
      return [entry.type];
  }
}

function describeMessageEntry(
  entry: MessageEntry,
  byParent: Map<string | null, SessionEntry[]>,
): string[] {
  const { message } = entry;

  switch (message.role) {
    case "user":
      return [`User: ${fullText(contentToText(message.content))}`];
    case "assistant":
      return describeAssistantMessage(entry, byParent, message);
    case "toolResult":
      return [];
    case "bashExecution":
      return [`Bash ${previewText(message.command, 120)}: ${previewText(message.output, 220)}`];
    case "custom":
      return [`Custom: ${fullText(contentToText(message.content))}`];
    default:
      return [describeFallbackMessage(message)];
  }
}

function describeLabeledText(label: string, value: unknown, limit: number): string {
  return `${label}: ${previewText(trimmedText(value), limit)}`;
}

function extractMessageChunks(
  entryId: string | undefined,
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
      return buildOptionalMessageChunk(
        entryId,
        "assistant",
        ts,
        "assistant_text",
        contentToText(message.content),
      );
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

function createMessageChunk(
  entryId: string | undefined,
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
  entryId: string | undefined,
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

function contentToText(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .filter(isTextBlock)
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function isTextBlock(part: unknown): part is TextBlock {
  return isRecord(part) && part.type === "text" && typeof part.text === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function describeAssistantMessage(
  entry: MessageEntry,
  byParent: Map<string | null, SessionEntry[]>,
  assistantMessage: AssistantMessage,
): string[] {
  const blocks: string[] = [];
  const text = contentToText(assistantMessage.content);
  if (text) {
    blocks.push(`Assistant: ${fullText(text)}`);
  }

  const toolCalls = getAssistantToolCalls(assistantMessage.content);
  const toolResults = getToolResults(entry, byParent);
  const resultsByCallId = new Map<string, ToolResultEntry[]>();
  for (const result of toolResults) {
    const toolCallId = result.message.toolCallId;
    if (!toolCallId) continue;
    const existing = resultsByCallId.get(toolCallId) ?? [];
    existing.push(result);
    resultsByCallId.set(toolCallId, existing);
  }

  for (const toolCall of toolCalls) {
    const toolResultGroup = resultsByCallId.get(toolCall.id) ?? [];
    blocks.push(...describeToolOperation(toolCall, toolResultGroup));
  }

  return blocks.length > 0 ? blocks : ["Assistant"];
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

function getChildEntries(
  entryId: string | undefined,
  byParent: Map<string | null, SessionEntry[]>,
): SessionEntry[] {
  return byParent.get(entryId ?? null) ?? [];
}

function getDescendantChildren(
  entries: SessionEntry[],
  byParent: Map<string | null, SessionEntry[]>,
): SessionEntry[] {
  const descendants: SessionEntry[] = [];

  for (const entry of entries) {
    descendants.push(...getChildEntries(entry.id, byParent));
  }

  return descendants;
}

function isToolResultEntry(entry: SessionEntry): entry is ToolResultEntry {
  return entry.type === "message" && entry.message.role === "toolResult";
}

function getToolResults(
  entry: MessageEntry,
  byParent: Map<string | null, SessionEntry[]>,
): ToolResultEntry[] {
  const results: ToolResultEntry[] = [];
  let currentChildren = getChildEntries(entry.id, byParent);

  while (currentChildren.length > 0) {
    const toolResults = currentChildren.filter(isToolResultEntry);

    if (toolResults.length === 0) {
      break;
    }

    results.push(...toolResults);
    currentChildren = getDescendantChildren(toolResults, byParent);
  }

  return results;
}

function getRenderableChildren(
  entry: SessionEntry,
  byParent: Map<string | null, SessionEntry[]>,
): SessionEntry[] {
  let currentChildren = getChildEntries(entry.id, byParent);

  while (currentChildren.length > 0) {
    const nonToolResultChildren = currentChildren.filter((child) => !isToolResultEntry(child));
    if (nonToolResultChildren.length > 0) {
      return nonToolResultChildren;
    }

    currentChildren = getDescendantChildren(currentChildren, byParent);
  }

  return [];
}

function describeToolOperation(toolCall: ToolCallBlock, toolResults: ToolResultEntry[]): string[] {
  const args = toolCall.arguments ?? {};
  const resultLines = summarizeToolResults(toolCall.name, toolResults);

  switch (toolCall.name) {
    case "read":
      return formatToolOperation(`Read ${stringArg(args.path, "(unknown path)")}`, resultLines);
    case "bash":
      return formatToolOperation(
        `Bash ${fullText(stringArg(args.command, "(no command)"))}`,
        resultLines,
      );
    case "search_web":
      return formatToolOperation(`Search web ${fullText(JSON.stringify(args))}`, resultLines);
    case "fetch_web":
      return formatToolOperation(`Fetch web ${fullText(JSON.stringify(args))}`, resultLines);
    case "edit":
      return formatToolOperation(`Edit ${stringArg(args.path, "(unknown path)")}`, resultLines);
    case "write":
      return formatToolOperation(`Write ${stringArg(args.path, "(unknown path)")}`, resultLines);
    default:
      return formatToolOperation(toolCall.name, resultLines);
  }
}

function stringArg(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function summarizeToolResults(toolName: string, toolResults: ToolResultEntry[]): string[] {
  if (toolResults.length === 0) {
    return ["(pending result)"];
  }

  const shouldTruncate = toolName !== "write";
  const parts = toolResults
    .map((toolResult) => {
      const text = contentToText(toolResult.message.content);
      return shouldTruncate ? truncateText(text, TOOL_RESULT_TEXT_LIMIT) : text;
    })
    .filter((text) => text.trim().length > 0);

  if (parts.length === 0) {
    return ["(no text output)"];
  }

  return parts;
}

function formatToolOperation(label: string, resultLines: string[]): string[] {
  return [label, "```", ...resultLines, "```"];
}

function truncateText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}…`;
}

function fullText(text: string): string {
  const cleaned = text.replace(/\s+/g, " ").trim();
  return cleaned || "(no text)";
}

function previewText(text: string, limit: number): string {
  return truncateText(fullText(text), limit);
}

type MessageEntry = SessionMessageEntry;

interface SummaryDetails {
  readFiles?: unknown;
  modifiedFiles?: unknown;
}

interface TextBlock {
  type: "text";
  text: string;
}

type ToolCallBlock = ToolCall & {
  arguments: Record<string, unknown>;
};

type ToolResultEntry = MessageEntry & {
  message: ToolResultMessage;
};

function isSessionEntry(entry: SessionHeader | SessionEntry): entry is SessionEntry {
  return entry.type !== "session";
}

function getSummaryDetails(details: unknown): SummaryDetails | undefined {
  return safeParseTypeBoxValue(SUMMARY_DETAILS_SCHEMA, details);
}

function describeFallbackMessage(message: AgentMessage): string {
  return hasMessageContent(message)
    ? `${message.role}: ${fullText(contentToText(message.content))}`
    : message.role;
}

function hasMessageContent(message: AgentMessage): message is AgentMessage & { content: unknown } {
  return "content" in message;
}
