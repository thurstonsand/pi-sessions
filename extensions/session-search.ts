import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import {
  buildSearchSessionsQuery,
  getDefaultIndexPath,
  getIndexStatus,
  INDEX_SCHEMA_VERSION,
  openIndexDatabase,
  type SearchSessionResult,
  type SearchSessionsParams,
  type SessionIndexStatus,
} from "./session-search/db.js";

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
  results: SearchSessionResult[];
  status?: SessionIndexStatus | undefined;
}

export default function sessionSearchExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "session_search",
    label: "Session Search",
    description:
      "Search across the prebuilt Pi session index to find relevant prior sessions by text, files, repo, time, and cwd.",
    parameters: Type.Object({
      query: Type.Optional(
        Type.String({ description: "Text to search for in indexed session content." }),
      ),
      files: Type.Optional(
        Type.Object({
          touched: Type.Optional(
            Type.Array(
              Type.String({ description: "Return sessions that read or changed this file path." }),
            ),
          ),
        }),
      ),
      repo: Type.Optional(
        Type.String({ description: "Limit results to sessions associated with this repo root." }),
      ),
      cwd: Type.Optional(
        Type.String({ description: "Limit results to sessions at or under this cwd." }),
      ),
      time: Type.Optional(
        Type.Object({
          after: Type.Optional(
            Type.String({
              description: "Only include sessions modified on or after this ISO date/time.",
            }),
          ),
          before: Type.Optional(
            Type.String({
              description: "Only include sessions modified before this ISO date/time.",
            }),
          ),
        }),
      ),
      limit: Type.Optional(Type.Number({ description: "Maximum number of sessions to return." })),
    }),
    async execute(_toolCallId, params: SessionSearchToolParams, _signal, _onUpdate, _ctx) {
      const validationError = validateSearchParams(params);
      if (validationError) {
        return {
          content: [{ type: "text", text: validationError }],
          details: { error: true, results: [] } satisfies SessionSearchToolDetails,
        };
      }

      const status = getIndexStatus();
      if (!status.exists || status.schemaVersion !== INDEX_SCHEMA_VERSION) {
        return {
          content: [
            {
              type: "text",
              text: `Session index missing or incompatible at ${getDefaultIndexPath()}. Run /session-index and press r to rebuild it.`,
            },
          ],
          details: { error: true, status, results: [] } satisfies SessionSearchToolDetails,
        };
      }

      const db = openIndexDatabase(status.dbPath, { create: false });
      try {
        const results = buildSearchSessionsQuery(db, buildSearchParams(params));

        if (results.length === 0) {
          return {
            content: [{ type: "text", text: "No matching sessions found." }],
            details: { error: false, status, results: [] } satisfies SessionSearchToolDetails,
          };
        }

        return {
          content: [{ type: "text", text: formatSearchResults(results) }],
          details: { error: false, status, results } satisfies SessionSearchToolDetails,
        };
      } finally {
        db.close();
      }
    },
    renderResult(result, { isPartial }, theme) {
      if (isPartial) {
        return new Text(theme.fg("warning", "Searching sessions..."), 0, 0);
      }

      const details = result.details as SessionSearchToolDetails | undefined;
      const content = result.content[0];
      if (content?.type !== "text") {
        return new Text(theme.fg("error", "No search output"), 0, 0);
      }

      if (!details || details.error) {
        return new Text(theme.fg("error", content.text), 0, 0);
      }

      if (details.results.length === 0) {
        return new Text(theme.fg("warning", content.text), 0, 0);
      }

      return new Text(
        formatSearchResults(details.results, {
          cwd: (text) => theme.fg("accent", text),
          primary: (text) => text,
          secondary: (text) => theme.fg("dim", text),
        }),
        0,
        0,
      );
    },
  });
}

function buildSearchParams(params: SessionSearchToolParams): SearchSessionsParams {
  return {
    query: params.query,
    touched: params.files?.touched,
    repo: params.repo,
    cwd: params.cwd,
    after: params.time?.after,
    before: params.time?.before,
    limit: params.limit,
  };
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

  if (result.snippet && result.snippet !== result.sessionName && result.snippet !== result.cwd) {
    lines.push(styles.secondary(`snippet: ${result.snippet}`));
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
