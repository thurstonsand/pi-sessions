import path from "node:path";
import type { ExtensionAPI, ExtensionContext, Theme } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import {
  stripSearchSnippetMarkers,
  transformSearchSnippetMatches,
} from "./shared/search-snippet.js";
import {
  getIndexStatus,
  INDEX_SCHEMA_VERSION,
  openIndexDatabase,
  type SearchSessionResult,
  type SearchSessionsParams,
  type SessionIndexStatus,
  searchSessions,
} from "./shared/session-index/index.js";
import { formatSessionTitleOrShortId } from "./shared/session-ui.js";
import { loadSettings } from "./shared/settings.js";

interface SessionSearchToolParams {
  query?: string;
  files?: {
    touched?: string[];
  };
  repo?: string;
  cwd?: string;
  time?: {
    after?: string;
    before?: string;
  };
  limit?: number;
}

interface SessionSearchToolDetails {
  error: boolean;
  params?: SessionSearchToolParams | undefined;
  results: SearchSessionResult[];
  status?: SessionIndexStatus | undefined;
}

const DEFAULT_SESSION_SEARCH_LIMIT = 6;
const COLLAPSED_RESULT_PREVIEW_ROWS = 6;

export default function sessionSearchExtension(pi: ExtensionAPI): void {
  const settings = loadSettings();

  pi.registerTool({
    name: "session_search",
    label: "Session Search",
    description: "Search prior Pi sessions",
    promptSnippet: "Use when you need to locate an earlier session to do a detailed follow-up",
    promptGuidelines: [
      "query is plain text only. Do not use boolean operators like OR/AND, parentheses, regex, or other search syntax",
      "If you want alternatives, run multiple session_search calls with different queries",
      "Once you have the right session id, switch to session_ask for questions about that session",
    ],
    parameters: Type.Object({
      query: Type.Optional(
        Type.String({
          description: "Free-text terms to match against",
        }),
      ),
      files: Type.Optional(
        Type.Object({
          touched: Type.Optional(
            Type.Array(
              Type.String({
                description: "File path touched in the session",
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
          description: "Directory the session was started in",
        }),
      ),
      time: Type.Optional(
        Type.Object({
          after: Type.Optional(
            Type.String({
              description: "Inclusive lower bound for session modified time, in ISO format",
            }),
          ),
          before: Type.Optional(
            Type.String({
              description: "Inclusive upper bound for session modified time, in ISO format",
            }),
          ),
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
        const details: SessionSearchToolDetails = {
          error: true,
          params,
          results: [],
        };
        return {
          content: [{ type: "text", text: validationError }],
          details,
        };
      }

      const progressDetails: SessionSearchToolDetails = {
        error: false,
        params,
        results: [],
      };
      onUpdate?.({
        content: [{ type: "text", text: "Searching sessions..." }],
        details: progressDetails,
      });

      const indexPath = settings.index.path;
      const status = getIndexStatus(indexPath);
      if (!status.exists || status.schemaVersion !== INDEX_SCHEMA_VERSION) {
        const details: SessionSearchToolDetails = {
          error: true,
          params,
          status,
          results: [],
        };
        return {
          content: [
            {
              type: "text",
              text: `Session index missing or incompatible at ${indexPath}. Run /session-index and press r to rebuild it.`,
            },
          ],
          details,
        };
      }

      const db = openIndexDatabase(status.dbPath, { create: false });
      try {
        const results = searchSessions(db, buildSearchParams(params, ctx));

        if (results.length === 0) {
          const details: SessionSearchToolDetails = {
            error: false,
            params,
            status,
            results: [],
          };
          return {
            content: [{ type: "text", text: "No matching sessions found." }],
            details,
          };
        }

        const details: SessionSearchToolDetails = {
          error: false,
          params,
          status,
          results,
        };
        return {
          content: [{ type: "text", text: formatSearchResults(results) }],
          details,
        };
      } finally {
        db.close();
      }
    },
    renderResult(result, { expanded, isPartial }, theme) {
      const details = result.details as SessionSearchToolDetails | undefined;
      const content = result.content[0];
      if (content?.type !== "text") {
        return new Text(theme.fg("error", "No search output"), 0, 0);
      }

      if (isPartial) {
        const lines = [theme.bold(theme.fg("warning", "Searching sessions..."))];
        lines.push(...formatSessionSearchContextLines(details?.params, theme));
        return new Text(lines.join("\n"), 0, 0);
      }

      if (!details || details.error) {
        return new Text(theme.fg("error", content.text), 0, 0);
      }

      const lines = formatSessionSearchContextLines(details.params, theme);
      if (details.results.length === 0) {
        if (lines.length > 0) lines.push("");
        lines.push(theme.fg("warning", content.text));
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
): SearchSessionsParams {
  const currentSessionId = ctx.sessionManager.getSessionId();

  return {
    query: params.query,
    touched: params.files?.touched,
    repo: params.repo,
    cwd: params.cwd,
    after: params.time?.after,
    before: params.time?.before,
    limit: params.limit ?? DEFAULT_SESSION_SEARCH_LIMIT,
    excludeSessionIds: currentSessionId ? [currentSessionId] : undefined,
  };
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
  if (params.files?.touched?.length) filters.push(`files: ${params.files.touched.join(", ")}`);
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
    const heading = `${index + 1}. ${theme.bold(formatSearchResultLabel(result))}${location ? ` ${theme.fg("dim", `(${location})`)}` : ""}`;
    const snippet = params?.query ? formatSearchSnippet(result) : undefined;
    return snippet ? [heading, theme.fg("dim", `  - ${snippet}`)] : [heading];
  });

  if (!expanded && results.length > visibleResults.length) {
    lines.push(theme.fg("dim", `... ${results.length - visibleResults.length} more`));
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

function formatSearchSnippet(result: SearchSessionResult): string | undefined {
  const plainSnippet = stripSearchSnippetMarkers(result.snippet)?.replace(/\s+/g, " ").trim();
  if (!plainSnippet) return undefined;
  if (plainSnippet === result.sessionName || plainSnippet === result.cwd) return undefined;
  return transformSearchSnippetMatches(result.snippet, (match) => `[${match}]`)
    ?.replace(/\s+/g, " ")
    .trim();
}

interface SearchResultTextStyles {
  cwd: (text: string) => string;
  primary: (text: string) => string;
  secondary: (text: string) => string;
}

function formatSearchResults(
  results: SearchSessionResult[],
  styles: SearchResultTextStyles = defaultSearchResultTextStyles,
): string {
  const groups = new Map<string, SearchSessionResult[]>();

  for (const result of results) {
    const bucket = groups.get(result.cwd);
    if (bucket) {
      bucket.push(result);
      continue;
    }

    groups.set(result.cwd, [result]);
  }

  return [...groups.entries()]
    .flatMap(([cwd, groupResults], groupIndex) => {
      const lines = [styles.cwd(`cwd: ${cwd}`)];
      for (const result of groupResults) {
        lines.push(...formatSearchResult(result, styles));
      }
      if (groupIndex < groups.size - 1) {
        lines.push("");
      }
      return lines;
    })
    .join("\n")
    .trim();
}

function formatSearchResult(result: SearchSessionResult, styles: SearchResultTextStyles): string[] {
  const lines = [styles.primary(`${result.sessionName || "[unnamed]"}: ${result.sessionId}`)];

  if (result.matchedFiles.length > 0) {
    lines.push(styles.secondary(`matched_files: ${result.matchedFiles.join(", ")}`));
  }

  if (result.score > 0 || result.hitCount > 0) {
    lines.push(styles.secondary(`score: ${result.score.toFixed(2)} / hits: ${result.hitCount}`));
  }

  const plainSnippet = stripSearchSnippetMarkers(result.snippet)?.replace(/\s+/g, " ").trim();
  if (plainSnippet && plainSnippet !== result.sessionName && plainSnippet !== result.cwd) {
    lines.push(styles.secondary(`snippet: ${plainSnippet}`));
  }

  return lines;
}

const defaultSearchResultTextStyles: SearchResultTextStyles = {
  cwd: (text) => text,
  primary: (text) => text,
  secondary: (text) => text,
};

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
