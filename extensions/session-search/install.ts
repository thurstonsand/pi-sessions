import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { MessagingHandle } from "../session-messaging/install.ts";
import type { IndexHandle } from "../shared/composition.ts";
import { stripSearchSnippetMarkers } from "../shared/search-snippet.ts";
import {
  type SearchSessionResult,
  type SearchSessionsParams,
  type SessionSearchEvidence,
  searchSessions,
  withSessionIndex,
} from "../shared/session-index/index.ts";
import type { SessionSettings } from "../shared/settings.ts";
import { renderSessionSearchResult } from "./renderer.ts";
import type { SessionSearchToolDetails, SessionSearchToolParams } from "./tool-contract.ts";

const DEFAULT_SESSION_SEARCH_LIMIT = 6;

export interface SearchInstallDeps {
  settings: SessionSettings;
  index: IndexHandle;
  messaging?: MessagingHandle | undefined;
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

      const liveSessionIds = params.live ? await getLiveSessionIds(deps.messaging) : undefined;

      return withSessionIndex(indexPath, { mode: "read", required: true }, ({ db, status }) => {
        const results = searchSessions(db, buildSearchParams(params, ctx, liveSessionIds));
        const details: SessionSearchToolDetails = {
          params,
          status,
          results,
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
    sort: params.sort,
    limit: params.limit ?? DEFAULT_SESSION_SEARCH_LIMIT,
    includeSessionIds: liveSessionIds,
    relativeToSessionId: currentSessionId,
  };
}

async function getLiveSessionIds(messaging: MessagingHandle | undefined): Promise<string[]> {
  if (!messaging) {
    throw new Error(
      "Session messaging is not active; live session search requires session messaging.",
    );
  }

  try {
    return await messaging.listSessionIds();
  } catch (error) {
    throw new Error(`Session messaging is unavailable: ${formatError(error)}`);
  }
}

function formatSearchResultsForModel(details: SessionSearchToolDetails): string {
  return JSON.stringify(
    {
      params: details.params,
      status: details.status,
      results: details.results.map(formatSearchResultForModel),
    },
    null,
    2,
  );
}

function formatSearchResultForModel(result: SearchSessionResult): SearchSessionResult {
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

function formatError(error: unknown): string {
  return error instanceof Error && error.message.trim() ? error.message : String(error);
}
