import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export interface SessionHeader {
  type: "session";
  id: string;
  timestamp: string;
  cwd: string;
  parentSession?: string;
  version?: number;
}

export interface SessionEntryBase {
  type: string;
  id?: string;
  parentId?: string | null;
  timestamp?: string;
}

export interface SearchTextChunk {
  entryId?: string | undefined;
  entryType: string;
  role?: string | undefined;
  ts: string;
  sourceKind: string;
  text: string;
}

export interface ExtractedSessionRecord {
  sessionId: string;
  sessionPath: string;
  sessionName: string;
  cwd: string;
  repoRoots: string[];
  startedAt: string;
  modifiedAt: string;
  messageCount: number;
  entryCount: number;
  chunks: SearchTextChunk[];
}

export interface ParsedSessionFile {
  header: SessionHeader;
  entries: SessionEntryBase[];
  sessionName: string;
}

const TOOL_RESULT_TEXT_LIMIT = 500;
const BASH_OUTPUT_TEXT_LIMIT = 500;

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
  let modifiedAt = fallbackTs;
  let messageCount = 0;

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
        const message = (entry as MessageEntry).message;
        if (!message) {
          continue;
        }

        messageCount += 1;
        chunks.push(...extractMessageChunks(entry.id, entryTs, message));
        continue;
      }
      case "custom_message":
        appendEntryTextChunk(
          chunks,
          entry,
          entryTs,
          "custom_message",
          contentToText((entry as CustomMessageEntry).content),
        );
        continue;
      case "branch_summary":
        appendEntryTextChunk(
          chunks,
          entry,
          entryTs,
          "branch_summary",
          trimmedText((entry as BranchSummaryEntry).summary),
        );
        continue;
      case "compaction":
        appendEntryTextChunk(
          chunks,
          entry,
          entryTs,
          "compaction_summary",
          trimmedText((entry as CompactionEntry).summary),
        );
        continue;
      default:
        continue;
    }
  }

  return {
    sessionId: parsed.header.id,
    sessionPath,
    sessionName: parsed.sessionName,
    cwd: parsed.header.cwd,
    repoRoots: [],
    startedAt: parsed.header.timestamp,
    modifiedAt,
    messageCount,
    entryCount: parsed.entries.length,
    chunks,
  };
}

export function parseSessionFile(sessionPath: string): ParsedSessionFile | undefined {
  const raw = readFileSync(sessionPath, "utf8");
  const lines = raw.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length === 0) return undefined;

  let header: SessionHeader | undefined;
  const entries: SessionEntryBase[] = [];
  let sessionName = "";

  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as SessionHeader | SessionEntryBase;
      if (entry.type === "session") {
        header = entry as SessionHeader;
        continue;
      }

      entries.push(entry);
      if (entry.type === "session_info") {
        const sessionInfoName = (entry as SessionInfoEntry).name;
        if (typeof sessionInfoName === "string") {
          sessionName = sessionInfoName.trim();
        }
      }
    } catch {
      // Ignore malformed lines.
    }
  }

  if (!header) {
    return undefined;
  }

  return { header, entries, sessionName };
}

function getEntryTimestamp(entry: SessionEntryBase, fallbackTs: string): string {
  return entry.timestamp ?? fallbackTs;
}

function appendEntryTextChunk(
  chunks: SearchTextChunk[],
  entry: SessionEntryBase,
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

function trimmedText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function groupEntriesByParent(entries: SessionEntryBase[]): Map<string | null, SessionEntryBase[]> {
  const byParent = new Map<string | null, SessionEntryBase[]>();

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

  lines.push("", "## Session Tree", "");
  return lines;
}

export function renderSessionTreeMarkdown(
  sessionPath: string,
  options?: { maxChars?: number },
): { markdown: string; sessionId: string; sessionName: string } {
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
  start: SessionEntryBase,
  byParent: Map<string | null, SessionEntryBase[]>,
  lines: string[],
  depth = 0,
): void {
  let current: SessionEntryBase | undefined = start;

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
  entry: SessionEntryBase,
  byParent: Map<string | null, SessionEntryBase[]>,
): string[] {
  switch (entry.type) {
    case "message":
      return describeMessageEntry(entry as MessageEntry, byParent);
    case "branch_summary":
      return [describeLabeledText("Branch summary", (entry as BranchSummaryEntry).summary, 220)];
    case "compaction":
      return [describeLabeledText("Compaction summary", (entry as CompactionEntry).summary, 220)];
    case "session_info":
      return [describeLabeledText("Session name", (entry as SessionInfoEntry).name, 180)];
    case "model_change": {
      const modelChange = entry as ModelChangeEntry;
      return [`Model: ${modelChange.provider}/${modelChange.modelId}`];
    }
    case "thinking_level_change": {
      const thinkingChange = entry as ThinkingLevelChangeEntry;
      return [`Thinking: ${thinkingChange.thinkingLevel}`];
    }
    default:
      return [entry.type];
  }
}

function describeMessageEntry(
  entry: MessageEntry,
  byParent: Map<string | null, SessionEntryBase[]>,
): string[] {
  const { message } = entry;
  if (!message) {
    return ["Message"];
  }

  switch (message.role) {
    case "user":
      return [`User: ${fullText(contentToText(message.content))}`];
    case "assistant":
      return describeAssistantMessage(entry, byParent);
    case "toolResult":
      return [];
    case "bashExecution": {
      const bashMessage = message as BashExecutionMessage;
      return [
        `Bash ${previewText(bashMessage.command, 120)}: ${previewText(bashMessage.output, 220)}`,
      ];
    }
    case "custom":
      return [`Custom: ${fullText(contentToText(message.content))}`];
    default:
      return [`${message.role}: ${fullText(contentToText(message.content))}`];
  }
}

function describeLabeledText(label: string, value: unknown, limit: number): string {
  return `${label}: ${previewText(trimmedText(value), limit)}`;
}

function extractMessageChunks(
  entryId: string | undefined,
  fallbackTs: string,
  message: SessionMessage,
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
      const bashMessage = message as BashExecutionMessage;
      const chunks: SearchTextChunk[] = [];

      if (bashMessage.command) {
        chunks.push(
          createMessageChunk(entryId, "bashExecution", ts, "bash_command", bashMessage.command),
        );
      }

      const output = truncateText(bashMessage.output, BASH_OUTPUT_TEXT_LIMIT);
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
  byParent: Map<string | null, SessionEntryBase[]>,
): string[] {
  const blocks: string[] = [];
  const assistantMessage = entry.message;
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
    typeof part.name === "string"
  );
}

function getChildEntries(
  entryId: string | undefined,
  byParent: Map<string | null, SessionEntryBase[]>,
): SessionEntryBase[] {
  return byParent.get(entryId ?? null) ?? [];
}

function getDescendantChildren(
  entries: SessionEntryBase[],
  byParent: Map<string | null, SessionEntryBase[]>,
): SessionEntryBase[] {
  const descendants: SessionEntryBase[] = [];

  for (const entry of entries) {
    descendants.push(...getChildEntries(entry.id, byParent));
  }

  return descendants;
}

function isToolResultEntry(entry: SessionEntryBase): entry is ToolResultEntry {
  return entry.type === "message" && (entry as MessageEntry).message?.role === "toolResult";
}

function getToolResults(
  entry: MessageEntry,
  byParent: Map<string | null, SessionEntryBase[]>,
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
  entry: SessionEntryBase,
  byParent: Map<string | null, SessionEntryBase[]>,
): SessionEntryBase[] {
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
  const cleaned = String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || "(no text)";
}

function previewText(text: string, limit: number): string {
  return truncateText(fullText(text), limit);
}

interface MessageEntry extends SessionEntryBase {
  type: "message";
  message: SessionMessage;
}

interface SessionInfoEntry extends SessionEntryBase {
  type: "session_info";
  name?: string;
}

interface CustomMessageEntry extends SessionEntryBase {
  type: "custom_message";
  content: unknown;
}

interface BranchSummaryEntry extends SessionEntryBase {
  type: "branch_summary";
  summary?: string;
}

interface CompactionEntry extends SessionEntryBase {
  type: "compaction";
  summary?: string;
}

interface SessionMessage {
  role: string;
  timestamp?: number;
  content?: unknown;
}

interface BashExecutionMessage extends SessionMessage {
  role: "bashExecution";
  command: string;
  output: string;
}

interface TextBlock {
  type: "text";
  text: string;
}

interface ToolCallBlock {
  type: "toolCall";
  id: string;
  name: string;
  arguments?: Record<string, unknown>;
}

interface ToolResultEntry extends MessageEntry {
  message: SessionMessage & {
    role: "toolResult";
    toolCallId?: string;
  };
}

interface ModelChangeEntry extends SessionEntryBase {
  type: "model_change";
  provider: string;
  modelId: string;
}

interface ThinkingLevelChangeEntry extends SessionEntryBase {
  type: "thinking_level_change";
  thinkingLevel: string;
}
