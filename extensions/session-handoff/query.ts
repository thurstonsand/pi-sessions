import { stripSearchSnippetMarkers } from "../shared/search-snippet.ts";
import {
  getSessionByPath,
  type SearchSessionResult,
  type SessionIndexDatabase,
  type SessionLineageRelation,
  searchSessions,
  withSessionIndex,
} from "../shared/session-index/index.ts";
import { SearchQuerySyntaxError } from "../shared/session-index/query/ast.ts";
import { shortenSessionId } from "../shared/session-ui.ts";
import { formatCompactRelativeTime } from "../shared/time.ts";

export const SESSION_TOKEN_PREFIX = "@session:";

const MAX_TREE_DEPTH = 3;

interface SessionPickerPresentationContext {
  currentSessionId?: string | undefined;
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
  snippet?: string | undefined;
  relation?: SessionLineageRelation | undefined;
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
  try {
    return (
      withSessionIndex(options.indexPath, { mode: "read", required: false }, ({ db }) => {
        const currentSession = options.currentSessionPath
          ? getSessionByPath(db, options.currentSessionPath)
          : undefined;
        const context = buildPresentationContext(currentSession?.sessionId);
        const searchResults = searchSessionsSafely(db, options, currentSession?.sessionId);
        const rankedResults =
          options.mode === "browse"
            ? prioritizeSessionResults(searchResults, context)
            : searchResults;

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
            : rankedResults.map((result) =>
                buildSessionItem(result, context, "", getBestTextSnippet(result)),
              );

        return {
          items: sessionItems,
          scopeMode,
          defaultScopeLabel,
        };
      }) ?? {
        items: [buildIndexErrorItem()],
        scopeMode,
        defaultScopeLabel,
      }
    );
  } catch (error) {
    if (error instanceof SearchQuerySyntaxError) {
      return {
        items: [buildSearchSyntaxErrorItem(error)],
        scopeMode,
        defaultScopeLabel,
      };
    }

    throw error;
  }
}

function searchSessionsSafely(
  db: SessionIndexDatabase,
  options: ListSessionPickerItemsOptions,
  currentSessionId?: string | undefined,
): SearchSessionResult[] {
  return searchSessions(db, {
    cwd: options.includeAll ? undefined : options.currentCwd,
    query: options.mode === "search" ? options.query : undefined,
    limit: options.limit,
    relativeToSessionId: currentSessionId,
  });
}

function buildPresentationContext(
  currentSessionId?: string | undefined,
): SessionPickerPresentationContext {
  return { currentSessionId };
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
  snippet?: string | undefined,
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
    snippet,
    relation: getSessionRelation(result, context),
  };
}

function getBestTextSnippet(result: SearchSessionResult): string | undefined {
  const textEvidence = result.evidence.find((evidence) => evidence.kind === "text");
  return textEvidence?.kind === "text" ? textEvidence.snippet : undefined;
}

function getSessionTitle(result: SearchSessionResult): string {
  return (
    normalizeDisplayText(result.sessionName) ??
    normalizeDisplayText(result.handoffNextTask) ??
    normalizeDisplayText(result.handoffGoal) ??
    normalizeDisplayText(result.firstUserPrompt) ??
    normalizeDisplayText(stripSearchSnippetMarkers(getBestTextSnippet(result))) ??
    shortenSessionId(result.sessionId)
  );
}

export function normalizeDisplayText(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : undefined;
}

function getSessionRelation(
  result: SearchSessionResult,
  context: SessionPickerPresentationContext,
): SessionLineageRelation | undefined {
  if (context.currentSessionId && result.sessionId === context.currentSessionId) {
    return "self";
  }

  return result.relation;
}

function getSessionMarker(
  result: SearchSessionResult,
  context: SessionPickerPresentationContext,
): string {
  switch (getSessionRelation(result, context)) {
    case "self":
      return "current";
    case "parent":
      return "parent";
    case "child":
      return "child";
    case "sibling":
      return "sibling";
    default:
      return shortenSessionId(result.sessionId);
  }
}

function buildIndexErrorItem(): SessionPickerNoticeItem {
  return {
    kind: "error",
    title: "Session index missing or incompatible",
    description: "Run /session-index to rebuild it.",
  };
}

function buildSearchSyntaxErrorItem(error: SearchQuerySyntaxError): SessionPickerNoticeItem {
  return {
    kind: "error",
    title: "Invalid search query",
    description: error.message,
  };
}

function buildEmptyResultItem(mode: "browse" | "search"): SessionPickerNoticeItem {
  return {
    kind: "empty",
    title: mode === "search" ? "No matches" : "No sessions",
  };
}
