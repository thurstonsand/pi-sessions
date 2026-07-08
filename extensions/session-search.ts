import path from "node:path";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { getKeybindings, type Keybinding, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import {
  stripSearchSnippetMarkers,
  transformSearchSnippetMatches,
} from "./shared/search-snippet.ts";
import {
  type ActiveSessionBrokerConnection,
  getActiveSessionBrokerConnection,
} from "./shared/session-broker/active.ts";
import {
  type SearchSessionResult,
  type SearchSessionsParams,
  type SearchSort,
  type SessionIndexStatus,
  type SessionSearchEvidence,
  searchSessions,
  withSessionIndex,
} from "./shared/session-index/index.ts";
import { formatSessionTitleOrShortId } from "./shared/session-ui.ts";
import { loadSettings } from "./shared/settings.ts";

interface SessionSearchToolParams {
  query?: string;
  files?: {
    touched?: string[];
    changed?: string[];
  };
  repo?: string;
  cwd?: string;
  time?: {
    after?: string;
    before?: string;
  };
  sort?: SearchSort;
  limit?: number;
  live?: boolean;
}

interface SessionSearchToolDetails {
  params?: SessionSearchToolParams | undefined;
  results: SearchSessionResult[];
  status?: SessionIndexStatus | undefined;
}

const DEFAULT_SESSION_SEARCH_LIMIT = 6;
const COLLAPSED_RESULT_PREVIEW_ROWS = 6;

export interface SessionSearchDeps {
  getBrokerConnection: () => ActiveSessionBrokerConnection | undefined;
}

export default function sessionSearchExtension(
  pi: ExtensionAPI,
  deps: SessionSearchDeps = {
    getBrokerConnection: getActiveSessionBrokerConnection,
  },
): void {
  const settings = loadSettings();

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

      const indexPath = settings.index.path;
      const liveSessionIds = params.live
        ? await getLiveSessionIds(deps.getBrokerConnection)
        : undefined;

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
    renderResult(result, { expanded, isPartial }, theme, context) {
      const details = result.details as SessionSearchToolDetails | undefined;
      const content = result.content[0];
      if (content?.type !== "text") {
        return new Text(theme.fg("error", "No search output"), 0, 0);
      }

      if (context.isError) {
        return new Text(theme.fg("error", content.text), 0, 0);
      }

      if (isPartial) {
        const lines = [theme.bold(theme.fg("warning", "Searching sessions..."))];
        lines.push(...formatSessionSearchContextLines(details?.params, theme));
        return new Text(lines.join("\n"), 0, 0);
      }

      if (!details) {
        return new Text(theme.fg("error", content.text), 0, 0);
      }

      const lines = formatSessionSearchContextLines(details.params, theme);
      if (details.results.length === 0) {
        if (lines.length > 0) lines.push("");
        lines.push(theme.fg("warning", "No matching sessions found."));
        return new Text(lines.join("\n"), 0, 0);
      }

      if (lines.length > 0) lines.push("");
      lines.push(
        ...formatSessionSearchPanelResults(details.results, details.params, expanded, theme),
      );
      return new Text(lines.join("\n"), 0, 0);
    },
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

async function getLiveSessionIds(
  getBrokerConnection: SessionSearchDeps["getBrokerConnection"],
): Promise<string[]> {
  const connection = getBrokerConnection();
  if (!connection) {
    throw new Error(
      "Session messaging is not active; live session search requires session messaging.",
    );
  }

  try {
    return await connection.listSessionIds();
  } catch (error) {
    throw new Error(`Session messaging is unavailable: ${formatError(error)}`);
  }
}

function formatSessionSearchContextLines(
  params: SessionSearchToolParams | undefined,
  theme: Theme,
): string[] {
  if (!params) return [];

  const lines: string[] = [];
  if (params.query?.trim()) {
    lines.push(theme.fg("muted", `query: ${params.query.trim()}`));
  }

  const filters: string[] = [];
  if (params.repo?.trim()) filters.push(`repo: ${params.repo.trim()}`);
  if (params.cwd?.trim()) filters.push(`cwd: ${params.cwd.trim()}`);
  if (params.files?.touched?.length)
    filters.push(`files.touched: ${params.files.touched.join(", ")}`);
  if (params.files?.changed?.length)
    filters.push(`files.changed: ${params.files.changed.join(", ")}`);
  if (params.live) filters.push("live: true");
  if (params.sort) filters.push(`sort: ${params.sort}`);
  if (params.time?.after?.trim()) filters.push(`after: ${params.time.after.trim()}`);
  if (params.time?.before?.trim()) filters.push(`before: ${params.time.before.trim()}`);
  if (params.limit !== undefined) filters.push(`limit: ${params.limit}`);

  if (filters.length > 0) {
    lines.push(theme.fg("dim", filters.join(" • ")));
  }

  if (lines.length === 0) {
    lines.push(theme.fg("dim", "all sessions"));
  }

  return lines;
}

function formatSessionSearchPanelResults(
  results: SearchSessionResult[],
  params: SessionSearchToolParams | undefined,
  expanded: boolean,
  theme: Theme,
): string[] {
  const visibleResults = expanded ? results : results.slice(0, COLLAPSED_RESULT_PREVIEW_ROWS);
  const lines = visibleResults.flatMap((result, index) => {
    const location = formatSearchResultLocation(result.cwd);
    const relation = result.relation ? ` ${theme.fg("dim", `[${result.relation}]`)}` : "";
    const heading = `${index + 1}. ${theme.bold(formatSearchResultLabel(result))}${relation}${location ? ` ${theme.fg("dim", `(${location})`)}` : ""}`;
    const snippets = params?.query ? formatSearchSnippets(result).slice(0, 3) : [];
    return snippets.length > 0
      ? [heading, ...snippets.map((snippet) => theme.fg("dim", `  - ${snippet}`))]
      : [heading];
  });

  if (!expanded && results.length > visibleResults.length) {
    lines.push(formatOverflowHint(results.length - visibleResults.length, results.length, theme));
  }

  return lines;
}

function formatSearchResultLabel(result: SearchSessionResult): string {
  return formatSessionTitleOrShortId(result.sessionName, result.sessionId);
}

function formatSearchResultLocation(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined;
  const base = path.basename(cwd);
  return base || cwd;
}

function formatSearchSnippets(result: SearchSessionResult): string[] {
  return result.evidence
    .filter((evidence): evidence is SearchTextEvidence => evidence.kind === "text")
    .map((evidence) => formatSearchSnippetText(evidence.snippet))
    .filter((snippet): snippet is string => Boolean(snippet));
}

interface SearchTextEvidence {
  kind: "text";
  sourceKind: string;
  snippet: string;
  score: number;
  entryId: string;
}

function formatSearchSnippetText(snippet: string): string | undefined {
  const plainSnippet = stripSearchSnippetMarkers(snippet)?.replace(/\s+/g, " ").trim();
  if (!plainSnippet) return undefined;
  return transformSearchSnippetMatches(snippet, (match) => `[${match}]`)
    ?.replace(/\s+/g, " ")
    .trim();
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

function formatOverflowHint(remaining: number, total: number, theme: Theme): string {
  return `${theme.fg("muted", `... (${remaining} more lines, ${total} total,`)} ${theme.fg(
    "dim",
    formatKeyHint("app.tools.expand"),
  )}${theme.fg("muted", " to expand)")}`;
}

function formatKeyHint(keybinding: Keybinding): string {
  return getKeybindings().getKeys(keybinding).join("/");
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
