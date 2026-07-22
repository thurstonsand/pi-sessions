import {
  type ExtensionAPI,
  type ExtensionContext,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { isSessionStarting } from "../session-handoff/metadata.ts";
import type { MessagingHandle } from "../session-messaging/install.ts";
import type { IndexHandle } from "../shared/composition.ts";
import { formatError } from "../shared/errors.ts";
import { stripSearchSnippetMarkers } from "../shared/search-snippet.ts";
import {
  getSessionById,
  type SearchSessionsParams,
  type SessionSearchEvidence,
  searchSessions,
  withSessionIndex,
} from "../shared/session-index/index.ts";
import type { SessionSettings } from "../shared/settings.ts";
import type { SubagentState } from "../subagents/classify.ts";
import type { SubagentRoster } from "../subagents/roster.ts";
import { renderSessionSearchResult } from "./renderer.ts";
import type {
  SessionSearchResult,
  SessionSearchToolDetails,
  SessionSearchToolParams,
} from "./tool-contract.ts";

const DEFAULT_SESSION_SEARCH_LIMIT = 6;

export interface SearchInstallDeps {
  settings: SessionSettings;
  index: IndexHandle;
  messaging?: MessagingHandle | undefined;
  roster?: SubagentRoster | undefined;
}

export function installSearch(pi: ExtensionAPI, deps: SearchInstallDeps): void {
  const indexPath = deps.index.path;

  pi.registerTool({
    name: "session_search",
    label: "Session Search",
    description: "Search Pi sessions",
    promptSnippet: "Locate Pi sessions for follow-up",
    promptGuidelines: [
      "Omit queries in session_search to list matching sessions chronologically.",
      "After session_search finds a session id, switch to session_ask for questions about it.",
      'To identify your own subagents, use session_search with relationScope: "branch".',
    ],
    parameters: Type.Object({
      query: Type.Optional(
        Type.String({
          description:
            "Use plain adjacent terms for normal search. Supports quoted phrases, AND/OR/NOT, parentheses, and -term negation when matching needs to be stricter.",
        }),
      ),
      files: Type.Optional(
        Type.Object({
          touched: Type.Optional(
            Type.Array(
              Type.String({
                description: "File path read or changed in the session",
              }),
            ),
          ),
          changed: Type.Optional(
            Type.Array(
              Type.String({
                description: "File path changed in the session",
              }),
            ),
          ),
        }),
      ),
      repo: Type.Optional(
        Type.String({
          description: "Git repository touched in the session",
        }),
      ),
      cwd: Type.Optional(
        Type.String({
          description: "Directory of the session",
        }),
      ),
      time: Type.Optional(
        Type.Object({
          after: Type.Optional(
            Type.String({
              description: "Inclusive lower bound for the session activity interval, in ISO format",
            }),
          ),
          before: Type.Optional(
            Type.String({
              description: "Inclusive upper bound for the session activity interval, in ISO format",
            }),
          ),
        }),
      ),
      sort: Type.Optional(
        Type.Union(
          [Type.Literal("relevance"), Type.Literal("modified_desc"), Type.Literal("modified_asc")],
          {
            description: "Display order for returned matches",
          },
        ),
      ),
      live: Type.Optional(
        Type.Boolean({
          description: "When true, only return currently active sessions",
        }),
      ),
      kind: Type.Optional(
        Type.Union([Type.Literal("user"), Type.Literal("subagent")], {
          description: "Filter by session kind",
        }),
      ),
      relationScope: Type.Optional(
        Type.Union([Type.Literal("branch"), Type.Literal("tree")], {
          description:
            "Restrict results to subagents launched from the active branch or anywhere in this session's conversation tree",
        }),
      ),
      limit: Type.Optional(
        Type.Number({
          description: "Number of matches to return",
        }),
      ),
    }),
    async execute(_toolCallId, params: SessionSearchToolParams, _signal, onUpdate, ctx) {
      const validationError = validateSearchParams(params);
      if (validationError) {
        throw new Error(validationError);
      }

      const progressDetails: SessionSearchToolDetails = {
        params,
        results: [],
      };
      onUpdate?.({
        content: [{ type: "text", text: "Searching sessions..." }],
        details: progressDetails,
      });

      const scope = await resolveSearchScope(params, deps);

      return withSessionIndex(indexPath, { mode: "read", required: true }, ({ db, status }) => {
        const results = searchSessions(
          db,
          buildSearchParams(params, ctx, scope.includeSessionIds),
        ).map((result): SessionSearchResult => {
          const annotation = scope.annotations.get(result.sessionId);
          if (!annotation) {
            return result;
          }
          if ("depth" in annotation) {
            return {
              ...result,
              state: annotation.state,
              depth: annotation.depth,
              onActiveBranch: annotation.onActiveBranch,
            };
          }
          return { ...result, state: annotation.state };
        });
        const details: SessionSearchToolDetails = {
          params,
          status,
          results,
          ...(scope.total === undefined
            ? {}
            : { scope: { matched: results.length, total: scope.total } }),
        };
        return {
          content: [
            {
              type: "text" as const,
              text: formatSearchResultsForModel(details),
            },
          ],
          details,
        };
      });
    },
    renderResult: renderSessionSearchResult,
  });
}

function buildSearchParams(
  params: SessionSearchToolParams,
  ctx: ExtensionContext,
  liveSessionIds?: string[] | undefined,
): SearchSessionsParams {
  const currentSessionId = ctx.sessionManager.getSessionId();

  return {
    query: params.query,
    touched: params.files?.touched,
    changed: params.files?.changed,
    repo: params.repo,
    cwd: params.cwd,
    after: params.time?.after,
    before: params.time?.before,
    kind: params.kind,
    sort: params.sort,
    limit: params.limit ?? DEFAULT_SESSION_SEARCH_LIMIT,
    includeSessionIds: liveSessionIds,
    relativeToSessionId: currentSessionId,
  };
}

interface StartingSearchResultAnnotation {
  state: "starting";
}

interface RelatedSubagentSearchResultAnnotation {
  state: SubagentState;
  depth: number;
  onActiveBranch: boolean;
}

type SearchResultAnnotation =
  | StartingSearchResultAnnotation
  | RelatedSubagentSearchResultAnnotation;

interface ResolvedSearchScope {
  includeSessionIds: string[] | undefined;
  annotations: ReadonlyMap<string, SearchResultAnnotation>;
  total: number | undefined;
}

async function resolveSearchScope(
  params: SessionSearchToolParams,
  deps: SearchInstallDeps,
): Promise<ResolvedSearchScope> {
  if (params.relationScope) {
    if (!deps.roster) {
      throw new Error("Subagent relations are unavailable because subagents are not active.");
    }
    try {
      const roster = await deps.roster.resolve(params.relationScope);
      const entries = params.live
        ? roster.entries.filter((entry) => entry.managedLive)
        : roster.entries;
      const annotations = new Map<string, SearchResultAnnotation>();
      for (const entry of roster.entries) {
        annotations.set(entry.sessionId, {
          state: entry.state,
          depth: entry.depth,
          onActiveBranch: entry.onActiveBranch,
        });
      }
      return {
        includeSessionIds: entries.map((entry) => entry.sessionId),
        annotations,
        total: roster.total,
      };
    } catch (error) {
      throw new Error(`Subagent relation scope is unavailable: ${formatError(error)}`);
    }
  }

  if (!params.live) {
    return {
      includeSessionIds: undefined,
      annotations: new Map(),
      total: undefined,
    };
  }

  const liveSessionIds = await getLiveSessionIds(deps.messaging);
  return {
    includeSessionIds: liveSessionIds,
    annotations: getStartingSessionAnnotations(liveSessionIds, deps.index.path),
    total: undefined,
  };
}

function getStartingSessionAnnotations(
  sessionIds: readonly string[],
  indexPath: string,
): ReadonlyMap<string, SearchResultAnnotation> {
  return withSessionIndex(indexPath, { mode: "read", required: true }, ({ db }) => {
    const annotations = new Map<string, SearchResultAnnotation>();
    for (const sessionId of sessionIds) {
      const session = getSessionById(db, sessionId);
      if (!session) {
        continue;
      }
      try {
        if (isSessionStarting(SessionManager.open(session.sessionPath).getBranch())) {
          annotations.set(sessionId, { state: "starting" });
        }
      } catch {}
    }
    return annotations;
  });
}

async function getLiveSessionIds(messaging: MessagingHandle | undefined): Promise<string[]> {
  if (!messaging) {
    throw new Error(
      "Session messaging is not active; live session search requires session messaging.",
    );
  }

  try {
    return await messaging.listSessions();
  } catch (error) {
    throw new Error(`Session messaging is unavailable: ${formatError(error)}`);
  }
}

function formatSearchResultsForModel(details: SessionSearchToolDetails): string {
  return JSON.stringify(
    {
      params: details.params,
      status: details.status,
      ...(details.scope ? { scope: details.scope } : {}),
      results: details.results.map(formatSearchResultForModel),
    },
    null,
    2,
  );
}

function formatSearchResultForModel(result: SessionSearchResult): SessionSearchResult {
  return {
    ...result,
    snippet: stripSearchSnippetMarkers(result.snippet) ?? result.snippet,
    evidence: result.evidence.map(formatEvidenceForModel),
  };
}

function formatEvidenceForModel(evidence: SessionSearchEvidence): SessionSearchEvidence {
  if (evidence.kind !== "text") {
    return evidence;
  }

  return {
    ...evidence,
    snippet: stripSearchSnippetMarkers(evidence.snippet) ?? evidence.snippet,
  };
}

function validateSearchParams(params: SessionSearchToolParams): string | undefined {
  if (params.time?.after && !isValidIsoDateLike(params.time.after)) {
    return `Invalid time.after value: ${params.time.after}`;
  }

  if (params.time?.before && !isValidIsoDateLike(params.time.before)) {
    return `Invalid time.before value: ${params.time.before}`;
  }

  if (params.time?.after && params.time?.before) {
    const after = new Date(params.time.after);
    const before = new Date(params.time.before);
    if (after.getTime() > before.getTime()) {
      return `time.after must be less than or equal to time.before`;
    }
  }

  if (params.limit !== undefined && params.limit <= 0) {
    return `limit must be greater than 0`;
  }

  return undefined;
}

function isValidIsoDateLike(value: string): boolean {
  const date = new Date(value);
  return !Number.isNaN(date.getTime());
}
