import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import {
  type SessionEntry,
  type SessionHeader,
  SessionManager,
  type SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import { HANDOFF_KICKOFF_CUSTOM_TYPE } from "../session-handoff/kickoff.ts";
import { contentToText, isRecord, truncateBlock, truncateInline } from "../shared/text.ts";

const MAX_TOOL_RESULT_PREVIEW_CHARS = 300;
const MAX_TOOL_CALL_ARGUMENT_PREVIEW_CHARS = 300;
const MAX_ENTRY_RENDER_CHARS = 12_000;
const MAX_SESSION_READ_RESULT_CHARS = 50 * 1024;
const MAX_AGENTS_MD_CHARS = 20_000;

export interface SessionNavigationData {
  header: SessionHeader;
  sessionName: string;
  entries: SessionEntry[];
  entryById: Map<string, SessionEntry>;
  childrenByParent: Map<string | null, SessionEntry[]>;
  activeLeafId: string | undefined;
  branches: SessionBranch[];
  spans: ConversationSpan[];
  branchPaths: Map<string, SessionEntry[]>;
  entryBranchesById: Map<string, SessionSearchHitBranch[]>;
  spanByEntryId: Map<string, EntrySpanLocation>;
  entrySizes: Map<string, number>;
}

export interface SessionBranch {
  leafId: string;
  startsAtEntryId: string;
  label: string;
  lastActivityAt: string;
  entryCount: number;
  isActive: boolean;
}

export interface ConversationSpan {
  startsAtEntryId: string;
  endsAtEntryId: string;
  branchesTo: string[];
  isActive: boolean;
  firstUserMessage?: SessionOutlineEntry | undefined;
  entryCount: number;
  lastActivityAt: string;
  branchSummary?: SessionOutlineEntry | undefined;
  compaction?: SessionOutlineEntry | undefined;
}

export type SessionReadBodyMode = "preview" | "full";

export interface SessionReadEntry {
  entryId: string;
  type: string;
  timestamp: string;
  pathTargetEntryId: string;
  body: SessionReadBodyMode;
  size: number;
  content: string;
  truncated: boolean;
}

export interface SessionReadResult {
  entries: SessionReadEntry[];
  nextEntryId?: string | undefined;
  pathTargetEntryId: string;
}

export interface SessionSearchHitBranch {
  branchLeafId: string;
  label: string;
  isActive: boolean;
}

export interface SessionSearchHitSpan {
  startsAtEntryId: string;
  endsAtEntryId: string;
  isActive: boolean;
  entriesBefore: number;
  entriesAfter: number;
}

interface EntrySpanLocation {
  span: ConversationSpan;
  pathEntries: SessionEntry[];
  startIndex: number;
  endIndex: number;
  entryIndex: number;
}

export interface SessionMetadataSummary {
  sessionId: string;
  sessionName: string;
  cwd: string;
  startedAt: string;
  modifiedAt: string;
  entryCount: number;
  messageCount: number;
}

export interface SessionOutlineEntry {
  entryId: string;
  type: string;
  timestamp: string;
  text: string;
}

export function loadSessionNavigationData(sessionPath: string): SessionNavigationData {
  const session = SessionManager.open(sessionPath);
  const header = session.getHeader();
  if (!header) {
    throw new Error(`Unable to parse session file: ${sessionPath}`);
  }

  const entries = session.getEntries().filter(hasEntryId);
  const entryById = new Map(entries.map((entry) => [entry.id, entry]));
  const childrenByParent = groupChildrenByParent(entries);
  const activeLeafId = session.getLeafId() ?? undefined;
  const leafIds = getLeafIds(entries, childrenByParent, activeLeafId);
  const branchPaths = new Map(leafIds.map((leafId) => [leafId, getPathToEntry(entryById, leafId)]));
  const pathCounts = countBranchPathEntries(branchPaths);
  const branches = leafIds.map((leafId) =>
    buildBranch(branchPaths.get(leafId) ?? [], leafId, activeLeafId, pathCounts),
  );
  const activePathIds = new Set(
    activeLeafId ? (branchPaths.get(activeLeafId) ?? []).map((entry) => entry.id) : [],
  );
  const spans = buildConversationSpans(childrenByParent, activePathIds);
  const entryBranchesById = buildEntryBranchesById(branches, branchPaths);
  const spanByEntryId = buildSpanByEntryId(spans, entryById);
  const entrySizes = new Map(entries.map((entry) => [entry.id, measureEntrySize(entry)]));

  return {
    header,
    sessionName: session.getSessionName() ?? "",
    entries,
    entryById,
    childrenByParent,
    activeLeafId,
    branches,
    spans,
    branchPaths,
    entryBranchesById,
    spanByEntryId,
    entrySizes,
  };
}

export function buildSessionMetadata(data: SessionNavigationData): SessionMetadataSummary {
  const timestamps = data.entries
    .map((entry) => entry.timestamp)
    .filter(Boolean)
    .sort();
  return {
    sessionId: data.header.id,
    sessionName: data.sessionName,
    cwd: data.header.cwd,
    startedAt: data.header.timestamp,
    modifiedAt: timestamps[timestamps.length - 1] ?? data.header.timestamp,
    entryCount: data.entries.length,
    messageCount: data.entries.filter((entry) => entry.type === "message").length,
  };
}

export function buildSessionMap(data: SessionNavigationData): string {
  return `- Entry ids are short hex-like ids such as \`1a2b3c4d\`.
- Pi sessions are trees: rewinds create multiple root-to-leaf conversation branches. Spans marked \`on_active_branch\` are part of the current live path; shared trunk spans can be on the active branch while still branching to abandoned spans.
- \`branches_to\` lists the next span start ids that continue from the current span. Multiple values mean the conversation forked there.
- Start with this map for structure. Prefer \`session_search\` to locate specific terms, decisions, files, or tool activity, then use \`session_read\` to inspect full evidence around the most relevant hits.

### Conversation Spans
${formatConversationSpans(data.spans)}`;
}

function formatConversationSpans(spans: ConversationSpan[]): string {
  if (spans.length === 0) {
    return "No conversation spans found.";
  }

  return spans.map(formatConversationSpan).join("\n\n");
}

function formatConversationSpan(span: ConversationSpan): string {
  const lines = [
    `#### Span (${span.startsAtEntryId}, ${span.endsAtEntryId})${span.isActive ? " (on_active_branch)" : ""}`,
    ...(span.branchesTo.length > 0 ? [`- branches_to: ${span.branchesTo.join(" | ")}`] : []),
    `- entries: ${span.entryCount}`,
    `- last_activity: ${span.lastActivityAt}`,
  ];

  if (span.firstUserMessage) {
    lines.push("- first_user_message:", formatMarkdownBlock(span.firstUserMessage.text, "  "));
  }

  if (span.branchSummary) {
    lines.push("- branch_summary:", formatBlockEntry(span.branchSummary));
  }

  if (span.compaction) {
    lines.push("- compaction:", formatBlockEntry(span.compaction));
  }

  return lines.join("\n");
}

function formatBlockEntry(entry: SessionOutlineEntry): string {
  return [
    `  entry: ${entry.entryId}`,
    `  timestamp: ${entry.timestamp}`,
    "  content:",
    formatMarkdownBlock(entry.text, "    "),
  ].join("\n");
}

function formatMarkdownBlock(value: string, prefix: string): string {
  return [`${prefix}\`\`\`\`md`, indentBlock(value, prefix), `${prefix}\`\`\`\``].join("\n");
}

export function readProjectAgentsMd(cwd: string): string | undefined {
  const agentsPath = path.join(cwd, "AGENTS.md");
  if (!existsSync(agentsPath)) {
    return undefined;
  }

  return truncateBlock(readFileSync(agentsPath, "utf8"), MAX_AGENTS_MD_CHARS).text;
}

export function readEntriesFromEntry(
  data: SessionNavigationData,
  params: {
    entryId: string;
    before?: number | undefined;
    after?: number | undefined;
    pathTargetEntryId?: string | undefined;
    body?: SessionReadBodyMode | undefined;
  },
): SessionReadResult {
  const anchor = data.entryById.get(params.entryId);
  if (!anchor) {
    throw new Error(`Entry not found: ${params.entryId}`);
  }

  if (params.before === undefined && params.after === undefined && !params.pathTargetEntryId) {
    throw new Error("session_read requires before/after or pathTarget.");
  }
  if (params.pathTargetEntryId && (params.before !== undefined || params.after !== undefined)) {
    throw new Error("session_read accepts either pathTarget or before/after, not both.");
  }

  const pathTargetEntryId = resolvePathTargetEntryId(data, anchor, params.pathTargetEntryId);
  const pathEntries = resolvePathEntries(data, pathTargetEntryId);
  const anchorIndex = pathEntries.findIndex((entry) => entry.id === anchor.id);
  if (anchorIndex < 0) {
    throw new Error(`Entry ${anchor.id} is not on path to ${pathTargetEntryId}.`);
  }

  const pathTargetIndex = pathEntries.findIndex((entry) => entry.id === pathTargetEntryId);
  const readRange = resolveReadRange({
    anchorIndex,
    pathTargetIndex,
    before: params.before,
    after: params.after,
  });
  assertReadStaysWithinSpan(data, pathEntries, readRange, params.pathTargetEntryId);
  const body = params.body ?? "preview";
  const requestedEntries = pathEntries.slice(readRange.startIndex, readRange.endIndex + 1);
  const page = renderReadPage(requestedEntries, pathTargetEntryId, data.entrySizes, body);
  const nextEntry =
    page.entries.length < requestedEntries.length
      ? requestedEntries[page.entries.length]
      : undefined;

  return {
    pathTargetEntryId,
    nextEntryId: nextEntry?.id,
    entries: page.entries,
  };
}

export function findBranchesForEntry(
  data: SessionNavigationData,
  entryId: string,
): SessionSearchHitBranch[] {
  return data.entryBranchesById.get(entryId) ?? [];
}

export function findSpanForEntry(
  data: SessionNavigationData,
  entryId: string,
): SessionSearchHitSpan | undefined {
  const location = data.spanByEntryId.get(entryId);
  if (!location) {
    return undefined;
  }

  const entryIndexInSpan = location.entryIndex - location.startIndex;
  const entryCount = location.endIndex - location.startIndex + 1;
  return {
    startsAtEntryId: location.span.startsAtEntryId,
    endsAtEntryId: location.span.endsAtEntryId,
    isActive: location.span.isActive,
    entriesBefore: entryIndexInSpan,
    entriesAfter: entryCount - entryIndexInSpan - 1,
  };
}

function hasEntryId(entry: SessionEntry): boolean {
  return typeof entry.id === "string" && entry.id.length > 0;
}

function groupChildrenByParent(entries: SessionEntry[]): Map<string | null, SessionEntry[]> {
  const groups = new Map<string | null, SessionEntry[]>();
  for (const entry of entries) {
    const parentId = entry.parentId ?? null;
    const group = groups.get(parentId) ?? [];
    group.push(entry);
    groups.set(parentId, group);
  }

  for (const group of groups.values()) {
    group.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }

  return groups;
}

function getLeafIds(
  entries: SessionEntry[],
  childrenByParent: Map<string | null, SessionEntry[]>,
  activeLeafId: string | undefined,
): string[] {
  const childParentIds = new Set(
    [...childrenByParent.keys()].filter((id): id is string => id !== null),
  );
  const leafIds = entries.filter((entry) => !childParentIds.has(entry.id)).map((entry) => entry.id);

  if (activeLeafId && !leafIds.includes(activeLeafId)) {
    leafIds.push(activeLeafId);
  }

  return leafIds;
}

function buildBranch(
  pathEntries: SessionEntry[],
  leafId: string,
  activeLeafId: string | undefined,
  pathCounts: Map<string, number>,
): SessionBranch {
  const leaf = pathEntries[pathEntries.length - 1];
  const startsAt = findBranchStart(pathEntries, pathCounts) ?? leaf;
  const startIndex = startsAt ? pathEntries.findIndex((entry) => entry.id === startsAt.id) : 0;
  const uniqueEntries = pathEntries.slice(Math.max(0, startIndex));
  return {
    leafId,
    startsAtEntryId: startsAt?.id ?? leafId,
    label: buildBranchLabel(uniqueEntries),
    lastActivityAt: leaf?.timestamp ?? "",
    entryCount: pathEntries.length,
    isActive: leafId === activeLeafId,
  };
}

function buildBranchLabel(entries: SessionEntry[]): string {
  const userMessage = findFirstUserMessage(entries);
  if (userMessage && "content" in userMessage.message) {
    return truncateInline(contentToText(userMessage.message.content), 80);
  }

  const leaf = entries[entries.length - 1];
  return leaf ? `${leaf.type} ${leaf.id}` : "empty branch";
}

function buildEntryBranchesById(
  branches: SessionBranch[],
  branchPaths: Map<string, SessionEntry[]>,
): Map<string, SessionSearchHitBranch[]> {
  const result = new Map<string, SessionSearchHitBranch[]>();
  const branchByLeafId = new Map(branches.map((branch) => [branch.leafId, branch]));

  for (const [leafId, pathEntries] of branchPaths) {
    const branch = branchByLeafId.get(leafId);
    if (!branch) {
      continue;
    }
    const hitBranch: SessionSearchHitBranch = {
      branchLeafId: branch.leafId,
      label: branch.label,
      isActive: branch.isActive,
    };
    for (const entry of pathEntries) {
      const current = result.get(entry.id) ?? [];
      current.push(hitBranch);
      result.set(entry.id, current);
    }
  }

  return result;
}

function buildSpanByEntryId(
  spans: ConversationSpan[],
  entryById: Map<string, SessionEntry>,
): Map<string, EntrySpanLocation> {
  const result = new Map<string, EntrySpanLocation>();

  for (const span of spans) {
    const pathEntries = getPathToEntry(entryById, span.endsAtEntryId);
    const startIndex = pathEntries.findIndex((entry) => entry.id === span.startsAtEntryId);
    const endIndex = pathEntries.findIndex((entry) => entry.id === span.endsAtEntryId);
    if (startIndex < 0 || endIndex < startIndex) {
      continue;
    }

    for (let entryIndex = startIndex; entryIndex <= endIndex; entryIndex++) {
      const entry = pathEntries[entryIndex];
      if (!entry) {
        continue;
      }
      result.set(entry.id, { span, pathEntries, startIndex, endIndex, entryIndex });
    }
  }

  return result;
}

function countBranchPathEntries(branchPaths: Map<string, SessionEntry[]>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const pathEntries of branchPaths.values()) {
    for (const entry of pathEntries) {
      counts.set(entry.id, (counts.get(entry.id) ?? 0) + 1);
    }
  }
  return counts;
}

function findBranchStart(
  pathEntries: SessionEntry[],
  pathCounts: Map<string, number>,
): SessionEntry | undefined {
  return pathEntries.find((entry) => (pathCounts.get(entry.id) ?? 0) === 1) ?? pathEntries[0];
}

function buildConversationSpans(
  childrenByParent: Map<string | null, SessionEntry[]>,
  activePathIds: Set<string>,
): ConversationSpan[] {
  return (childrenByParent.get(null) ?? []).flatMap((root) =>
    getConversationRootStarts(root, childrenByParent).flatMap((start) =>
      buildConversationSpansFrom(start, childrenByParent, activePathIds),
    ),
  );
}

function getConversationRootStarts(
  root: SessionEntry,
  childrenByParent: Map<string | null, SessionEntry[]>,
): SessionEntry[] {
  if (isConversationEntry(root)) {
    return [root];
  }

  const children = childrenByParent.get(root.id) ?? [];
  if (children.length === 0) {
    return [];
  }

  return children.flatMap((child) => getConversationRootStarts(child, childrenByParent));
}

function isConversationEntry(entry: SessionEntry): boolean {
  return (
    entry.type === "message" ||
    entry.type === "custom_message" ||
    entry.type === "branch_summary" ||
    entry.type === "compaction"
  );
}

function buildConversationSpansFrom(
  startEntry: SessionEntry,
  childrenByParent: Map<string | null, SessionEntry[]>,
  activePathIds: Set<string>,
): ConversationSpan[] {
  const entries = collectSpanEntries(startEntry, childrenByParent);
  const endEntry = entries[entries.length - 1] ?? startEntry;
  const branchesTo = getSpanBranchesTo(endEntry, childrenByParent);
  const span: ConversationSpan = {
    startsAtEntryId: startEntry.id,
    endsAtEntryId: endEntry.id,
    branchesTo: branchesTo.map((entry) => entry.id),
    isActive: entries.some((entry) => activePathIds.has(entry.id)),
    firstUserMessage: summarizeUserMessage(findFirstUserMessage(entries)),
    entryCount: entries.length,
    lastActivityAt: endEntry.timestamp,
    branchSummary:
      startEntry.type === "branch_summary" ? summarizeSummaryEntry(startEntry) : undefined,
    compaction: startEntry.type === "compaction" ? summarizeSummaryEntry(startEntry) : undefined,
  };

  return [
    span,
    ...branchesTo.flatMap((entry) =>
      buildConversationSpansFrom(entry, childrenByParent, activePathIds),
    ),
  ];
}

function collectSpanEntries(
  startEntry: SessionEntry,
  childrenByParent: Map<string | null, SessionEntry[]>,
): SessionEntry[] {
  const entries = [startEntry];
  let current = startEntry;

  while (true) {
    const children = childrenByParent.get(current.id) ?? [];
    if (children.length !== 1) {
      return entries;
    }

    const child = children[0];
    if (!child || isSpanStart(child)) {
      return entries;
    }

    entries.push(child);
    current = child;
  }
}

function getSpanBranchesTo(
  endEntry: SessionEntry,
  childrenByParent: Map<string | null, SessionEntry[]>,
): SessionEntry[] {
  const children = childrenByParent.get(endEntry.id) ?? [];
  if (children.length !== 1) {
    return children;
  }

  const onlyChild = children[0];
  return onlyChild && isSpanStart(onlyChild) ? [onlyChild] : [];
}

function isSpanStart(entry: SessionEntry): boolean {
  return entry.type === "branch_summary" || entry.type === "compaction";
}

function resolvePathTargetEntryId(
  data: SessionNavigationData,
  anchor: SessionEntry,
  pathTargetEntryId: string | undefined,
): string {
  if (pathTargetEntryId) {
    if (!data.entryById.has(pathTargetEntryId)) {
      throw new Error(`Path target entry not found: ${pathTargetEntryId}`);
    }
    return pathTargetEntryId;
  }

  const containingSpan = data.spanByEntryId.get(anchor.id)?.span;
  if (containingSpan) {
    return containingSpan.endsAtEntryId;
  }

  const containingBranches = data.entryBranchesById.get(anchor.id) ?? [];
  const activeBranch = containingBranches.find((branch) => branch.isActive);
  return activeBranch?.branchLeafId ?? containingBranches[0]?.branchLeafId ?? anchor.id;
}

interface ReadRange {
  startIndex: number;
  endIndex: number;
}

function resolveReadRange(params: {
  anchorIndex: number;
  pathTargetIndex: number;
  before?: number | undefined;
  after?: number | undefined;
}): ReadRange {
  if (params.before === undefined && params.after === undefined) {
    return {
      startIndex: params.anchorIndex,
      endIndex: params.pathTargetIndex,
    };
  }

  const before = normalizeContextCount(params.before);
  const after = normalizeContextCount(params.after);
  return {
    startIndex: Math.max(0, params.anchorIndex - before),
    endIndex: Math.max(params.anchorIndex, params.anchorIndex + after),
  };
}

function assertReadStaysWithinSpan(
  data: SessionNavigationData,
  pathEntries: SessionEntry[],
  readRange: ReadRange,
  explicitPathTargetEntryId: string | undefined,
): void {
  if (explicitPathTargetEntryId) {
    return;
  }

  const anchor = pathEntries[readRange.startIndex];
  const location = anchor ? data.spanByEntryId.get(anchor.id) : undefined;
  if (!anchor || !location) {
    return;
  }

  if (readRange.startIndex < location.startIndex || readRange.endIndex > location.endIndex) {
    throw new Error(
      `session_read context crosses span boundary from ${anchor.id}. Set pathTarget to ${location.span.endsAtEntryId} or another descendant entry id to read across spans.`,
    );
  }
}

function resolvePathEntries(data: SessionNavigationData, entryId: string): SessionEntry[] {
  return data.branchPaths.get(entryId) ?? getPathToEntry(data.entryById, entryId);
}

function getPathToEntry(entryById: Map<string, SessionEntry>, entryId: string): SessionEntry[] {
  const pathEntries: SessionEntry[] = [];
  let current = entryById.get(entryId);
  while (current) {
    pathEntries.push(current);
    current = current.parentId ? entryById.get(current.parentId) : undefined;
  }
  return pathEntries.reverse();
}

function normalizeContextCount(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.trunc(value)));
}

function renderReadPage(
  entries: SessionEntry[],
  pathTargetEntryId: string,
  entrySizes: Map<string, number>,
  body: SessionReadBodyMode,
): { entries: SessionReadEntry[] } {
  const renderedEntries: SessionReadEntry[] = [];
  let renderedSize = 0;

  for (const entry of entries) {
    const renderedEntry = renderReadEntry(entry, pathTargetEntryId, entrySizes, body);
    const nextSize = renderedSize + renderedEntry.content.length;
    if (renderedEntries.length > 0 && nextSize > MAX_SESSION_READ_RESULT_CHARS) {
      break;
    }

    renderedEntries.push(renderedEntry);
    renderedSize = nextSize;
  }

  return { entries: renderedEntries };
}

function renderReadEntry(
  entry: SessionEntry,
  pathTargetEntryId: string,
  entrySizes: Map<string, number>,
  body: SessionReadBodyMode,
): SessionReadEntry {
  const rendered = renderEntryContent(entry, body);
  const truncated = truncateBlock(rendered, MAX_ENTRY_RENDER_CHARS);
  return {
    entryId: entry.id,
    type: entry.type,
    timestamp: entry.timestamp,
    pathTargetEntryId,
    body,
    size: entrySizes.get(entry.id) ?? measureEntrySize(entry),
    content: truncated.text,
    truncated: truncated.truncated,
  };
}

function summarizeUserMessage(entry: SessionEntry | undefined): SessionOutlineEntry | undefined {
  if (entry?.type !== "message" || entry.message.role !== "user") {
    return undefined;
  }

  return {
    entryId: entry.id,
    type: "user",
    timestamp: entry.timestamp,
    text: contentToText(entry.message.content),
  };
}

function summarizeSummaryEntry(entry: SessionEntry): SessionOutlineEntry | undefined {
  if (entry.type !== "branch_summary" && entry.type !== "compaction") {
    return undefined;
  }

  return {
    entryId: entry.id,
    type: entry.type,
    timestamp: entry.timestamp,
    text: String(entry.summary ?? ""),
  };
}

function findFirstUserMessage(entries: SessionEntry[]): SessionMessageEntry | undefined {
  return entries.find(
    (entry): entry is SessionMessageEntry =>
      entry.type === "message" &&
      entry.message.role === "user" &&
      "content" in entry.message &&
      contentToText(entry.message.content).length > 0,
  );
}

function renderEntryContent(entry: SessionEntry, body: SessionReadBodyMode = "full"): string {
  if (entry.type === "message") {
    return renderMessageEntry(entry, body);
  }
  if (entry.type === "custom_message") {
    const label = entry.customType === HANDOFF_KICKOFF_CUSTOM_TYPE ? "Handoff kickoff" : "Custom";
    return `[${label}]: ${String(entry.content ?? "")}`;
  }
  if (entry.type === "compaction" || entry.type === "branch_summary") {
    return String(entry.summary ?? "");
  }
  if (entry.type === "session_info") {
    return String(entry.name ?? "");
  }
  return JSON.stringify(entry, null, 2);
}

function renderMessageEntry(entry: SessionMessageEntry, body: SessionReadBodyMode): string {
  const { message } = entry;
  switch (message.role) {
    case "user": {
      const text = contentToText(message.content);
      return text ? `[User]: ${text}` : "[User]";
    }
    case "assistant":
      return renderAssistantMessage(message, body);
    case "toolResult":
      return renderToolResultMessage(message, body);
    case "custom":
      return `[Custom]: ${contentToText(message.content)}`;
    case "bashExecution":
      return `[Bash]: ${message.command}\n${message.output ?? ""}`;
    default:
      return `[${message.role}]`;
  }
}

function renderAssistantMessage(message: AssistantMessage, body: SessionReadBodyMode): string {
  const content = Array.isArray(message.content) ? message.content : [];
  const textParts: string[] = [];
  let hasThinkingBlock = false;
  const thinkingParts: string[] = [];
  const toolCalls: string[] = [];

  for (const block of content) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
      textParts.push(block.text);
    } else if (isRecord(block) && block.type === "thinking") {
      hasThinkingBlock = true;
      if (typeof block.thinking === "string" && block.thinking.trim().length > 0) {
        thinkingParts.push(block.thinking);
      }
    } else if (isRecord(block) && block.type === "toolCall") {
      toolCalls.push(renderToolCall(block, body));
    }
  }

  const parts: string[] = [];
  if (hasThinkingBlock) {
    parts.push(
      body === "preview" || thinkingParts.length === 0
        ? "[Assistant thinking]: thinking…"
        : `[Assistant thinking]: ${thinkingParts.join("\n")}`,
    );
  }
  if (textParts.length > 0) {
    parts.push(`[Assistant]: ${textParts.join("\n")}`);
  }
  if (toolCalls.length > 0) {
    parts.push(`[Assistant tool calls]:\n${toolCalls.map((call) => `- ${call}`).join("\n")}`);
  }
  return parts.join("\n\n");
}

function renderToolResultMessage(message: ToolResultMessage, body: SessionReadBodyMode): string {
  const toolName = message.toolName ?? "unknown";
  const content = contentToText(message.content);
  if (body === "preview") {
    return [
      `[Tool result]`,
      `tool: ${toolName}`,
      `size: ${content.length}`,
      "preview:",
      truncateInline(content, MAX_TOOL_RESULT_PREVIEW_CHARS),
    ].join("\n");
  }

  return [
    `[Tool result]`,
    `tool: ${toolName}`,
    `size: ${content.length}`,
    "content:",
    content,
  ].join("\n");
}

function renderToolCall(block: Record<string, unknown>, body: SessionReadBodyMode): string {
  const name = typeof block.name === "string" ? block.name : "unknown";
  const args = isRecord(block.arguments) ? block.arguments : {};
  if (body === "full") {
    return `${name}(${safeJsonStringify(args)})`;
  }

  if (name === "edit") {
    return formatEditToolCall(args);
  }
  if (name === "write") {
    return formatWriteToolCall(args);
  }
  if (name === "bash") {
    return formatBashToolCall(args);
  }

  return `${name}(${truncateInline(safeJsonStringify(args), MAX_TOOL_CALL_ARGUMENT_PREVIEW_CHARS)})`;
}

function formatEditToolCall(args: Record<string, unknown>): string {
  const edits = Array.isArray(args.edits) ? args.edits.filter(isRecord) : [];
  const oldChars = edits.reduce((total, edit) => total + stringLength(edit.oldText), 0);
  const newChars = edits.reduce((total, edit) => total + stringLength(edit.newText), 0);
  return `edit(path=${safeJsonStringify(args.path)}, edits=${edits.length}, oldChars=${oldChars}, newChars=${newChars})`;
}

function formatWriteToolCall(args: Record<string, unknown>): string {
  return `write(path=${safeJsonStringify(args.path)}, contentChars=${stringLength(args.content)})`;
}

function formatBashToolCall(args: Record<string, unknown>): string {
  const command =
    typeof args.command === "string"
      ? truncateInline(args.command, MAX_TOOL_CALL_ARGUMENT_PREVIEW_CHARS)
      : "";
  const timeout = typeof args.timeout === "number" ? `, timeout=${args.timeout}` : "";
  return `bash(command=${safeJsonStringify(command)}${timeout})`;
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function stringLength(value: unknown): number {
  return typeof value === "string" ? value.length : 0;
}

function measureEntrySize(entry: SessionEntry): number {
  return renderEntryContent(entry, "full").length;
}

function indentBlock(value: string, prefix: string): string {
  return value
    .split(/\r?\n/)
    .map((line) => `${prefix}${line}`)
    .join("\n");
}
