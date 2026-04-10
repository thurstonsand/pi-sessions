import {
  getIndexStatus,
  getLineageSessions,
  getSessionByPath,
  INDEX_SCHEMA_VERSION,
  openIndexDatabase,
  type SearchSessionResult,
  type SessionIndexDatabase,
  type SessionLineageRelation,
  searchSessions,
} from "../shared/session-index/index.js";
import { formatCompactRelativeTime } from "../shared/time.js";

export const SESSION_TOKEN_PREFIX = "@session:";

const MAX_TREE_DEPTH = 3;

interface SessionPickerPresentationContext {
  currentSessionId?: string | undefined;
  relationBySessionId: Map<string, SessionLineageRelation>;
}

export interface SessionPickerSessionItem {
  kind: "session";
  sessionId: string;
  token: string;
  title: string;
  marker: string;
  messageCount: number;
  modifiedAtText?: string | undefined;
  prefix: string;
  relation?: SessionLineageRelation | "self" | undefined;
}

export interface SessionPickerNoticeItem {
  kind: "error" | "empty";
  title: string;
  description?: string | undefined;
}

export type SessionPickerItem = SessionPickerSessionItem | SessionPickerNoticeItem;

export interface ListSessionPickerItemsOptions {
  currentSessionPath?: string | undefined;
  currentCwd?: string | undefined;
  includeAll: boolean;
  indexPath: string;
  limit?: number | undefined;
  mode: "browse" | "search";
  query?: string | undefined;
}

export interface SessionPickerQueryResult {
  items: SessionPickerItem[];
  scopeMode: "default" | "all";
  defaultScopeLabel?: string | undefined;
}

interface BrowseTreeNode {
  result: SearchSessionResult;
  children: BrowseTreeNode[];
}

export function listSessionPickerItems(
  options: ListSessionPickerItemsOptions,
): SessionPickerQueryResult {
  const scopeMode = options.includeAll ? "all" : "default";
  const defaultScopeLabel = options.currentCwd ? "current folder" : undefined;
  const status = getIndexStatus(options.indexPath);
  if (!status.exists || status.schemaVersion !== INDEX_SCHEMA_VERSION) {
    return {
      items: [buildIndexErrorItem()],
      scopeMode,
      defaultScopeLabel,
    };
  }

  const db = openIndexDatabase(status.dbPath, { create: false });
  try {
    const currentSession = options.currentSessionPath
      ? getSessionByPath(db, options.currentSessionPath)
      : undefined;
    const context = buildPresentationContext(db, currentSession?.sessionId);
    const rankedResults = prioritizeSessionResults(
      searchSessions(
        db,
        {
          cwd: options.includeAll ? undefined : options.currentCwd,
          query: options.mode === "search" ? options.query : undefined,
          limit: options.limit,
        },
        { defaultLimit: undefined },
      ),
      context,
    );

    if (rankedResults.length === 0) {
      return {
        items: [buildEmptyResultItem(options.mode)],
        scopeMode,
        defaultScopeLabel,
      };
    }

    const sessionItems =
      options.mode === "browse"
        ? buildBrowseSessionItems(rankedResults, context)
        : rankedResults.map((result) => buildSessionItem(result, context));

    return {
      items: sessionItems,
      scopeMode,
      defaultScopeLabel,
    };
  } finally {
    db.close();
  }
}

function buildPresentationContext(
  db: SessionIndexDatabase,
  currentSessionId?: string | undefined,
): SessionPickerPresentationContext {
  return {
    currentSessionId,
    relationBySessionId: currentSessionId
      ? new Map(
          getLineageSessions(db, currentSessionId).map((row) => [row.sessionId, row.relation]),
        )
      : new Map<string, SessionLineageRelation>(),
  };
}

function prioritizeSessionResults(
  results: SearchSessionResult[],
  context: SessionPickerPresentationContext,
): SearchSessionResult[] {
  return results
    .map((result, index) => ({ result, index }))
    .sort((a, b) => {
      const priorityDiff =
        getSessionPriority(a.result, context) - getSessionPriority(b.result, context);
      if (priorityDiff !== 0) {
        return priorityDiff;
      }

      return a.index - b.index;
    })
    .map(({ result }) => result);
}

function getSessionPriority(
  result: SearchSessionResult,
  context: SessionPickerPresentationContext,
): number {
  switch (getSessionRelation(result, context)) {
    case "self":
      return 0;
    case "parent":
      return 1;
    case "child":
      return 2;
    case "sibling":
      return 3;
    case "ancestor":
      return 4;
    case "descendant":
      return 5;
    case "ancestor_sibling":
      return 6;
    default:
      return 7;
  }
}

function buildBrowseSessionItems(
  results: SearchSessionResult[],
  context: SessionPickerPresentationContext,
): SessionPickerSessionItem[] {
  const nodesById = new Map<string, BrowseTreeNode>();
  const roots: BrowseTreeNode[] = [];

  for (const result of results) {
    nodesById.set(result.sessionId, { result, children: [] });
  }

  for (const result of results) {
    const node = nodesById.get(result.sessionId);
    if (!node || !result.parentSessionId) {
      roots.push(node ?? { result, children: [] });
      continue;
    }

    const parent = nodesById.get(result.parentSessionId);
    if (!parent) {
      roots.push(node);
      continue;
    }

    parent.children.push(node);
  }

  const items: SessionPickerSessionItem[] = [];
  roots.forEach((root, index) => {
    flattenBrowseTree(items, root, context, 0, index === roots.length - 1);
  });
  return items;
}

function flattenBrowseTree(
  items: SessionPickerSessionItem[],
  node: BrowseTreeNode,
  context: SessionPickerPresentationContext,
  depth: number,
  isLast: boolean,
): void {
  items.push(buildSessionItem(node.result, context, buildTreePrefix(depth, isLast)));

  node.children.forEach((child, index) => {
    flattenBrowseTree(items, child, context, depth + 1, index === node.children.length - 1);
  });
}

function buildTreePrefix(depth: number, isLast: boolean): string {
  if (depth <= 0) {
    return "";
  }

  const visualDepth = Math.min(depth, MAX_TREE_DEPTH);
  return `${"  ".repeat(Math.max(0, visualDepth - 1))}${isLast ? "└─ " : "├─ "}`;
}

function buildSessionItem(
  result: SearchSessionResult,
  context: SessionPickerPresentationContext,
  prefix: string = "",
): SessionPickerSessionItem {
  return {
    kind: "session",
    sessionId: result.sessionId,
    token: `${SESSION_TOKEN_PREFIX}${result.sessionId}`,
    title: getSessionTitle(result),
    marker: getSessionMarker(result, context),
    messageCount: result.messageCount,
    modifiedAtText: formatCompactRelativeTime(result.modifiedAt),
    prefix,
    relation: getSessionRelation(result, context),
  };
}

function getSessionTitle(result: SearchSessionResult): string {
  return (
    normalizeDisplayText(result.sessionName) ??
    normalizeDisplayText(result.handoffNextTask) ??
    normalizeDisplayText(result.handoffGoal) ??
    normalizeDisplayText(result.firstUserPrompt) ??
    normalizeDisplayText(result.snippet) ??
    shortSessionId(result.sessionId)
  );
}

function normalizeDisplayText(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : undefined;
}

function getSessionRelation(
  result: SearchSessionResult,
  context: SessionPickerPresentationContext,
): SessionLineageRelation | "self" | undefined {
  if (context.currentSessionId && result.sessionId === context.currentSessionId) {
    return "self";
  }

  return context.relationBySessionId.get(result.sessionId);
}

function getSessionMarker(
  result: SearchSessionResult,
  context: SessionPickerPresentationContext,
): string {
  switch (getSessionRelation(result, context)) {
    case "self":
      return "this session";
    case "parent":
      return "parent";
    case "child":
      return "child";
    case "sibling":
      return "sibling";
    default:
      return shortSessionId(result.sessionId);
  }
}

function shortSessionId(sessionId: string): string {
  return sessionId.slice(0, 8);
}

function buildIndexErrorItem(): SessionPickerNoticeItem {
  return {
    kind: "error",
    title: "Session index missing or incompatible",
    description: "Run /session-index to rebuild it.",
  };
}

function buildEmptyResultItem(mode: "browse" | "search"): SessionPickerNoticeItem {
  return {
    kind: "empty",
    title: mode === "search" ? "No matches" : "No sessions",
  };
}
