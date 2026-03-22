import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import {
  buildSearchSessionsQuery,
  getDefaultIndexPath,
  getIndexStatus,
  INDEX_SCHEMA_VERSION,
  openIndexDatabase,
  type SearchSessionResult,
  type SearchSessionsParams,
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
    async execute(_toolCallId, params: SessionSearchToolParams) {
      const status = getIndexStatus();
      if (!status.exists || status.schemaVersion !== INDEX_SCHEMA_VERSION) {
        return {
          content: [
            {
              type: "text",
              text: `Session index missing or incompatible at ${getDefaultIndexPath()}. Run /session-index and press r to rebuild it.`,
            },
          ],
          details: { error: true, status, results: [] },
        };
      }

      const db = openIndexDatabase(status.dbPath, { create: false });
      try {
        const results = buildSearchSessionsQuery(db, buildSearchParams(params));

        if (results.length === 0) {
          return {
            content: [{ type: "text", text: "No matching sessions found." }],
            details: { error: false, status, results: [] },
          };
        }

        return {
          content: [{ type: "text", text: formatSearchResults(results) }],
          details: { error: false, status, results },
        };
      } finally {
        db.close();
      }
    },
  });
}

function buildSearchParams(params: SessionSearchToolParams): SearchSessionsParams {
  const searchParams: SearchSessionsParams = {};

  if (params.query) {
    searchParams.query = params.query;
  }

  if (params.files?.touched?.length) {
    searchParams.touched = params.files.touched;
  }

  if (params.repo) {
    searchParams.repo = params.repo;
  }

  if (params.cwd) {
    searchParams.cwd = params.cwd;
  }

  if (params.time?.after) {
    searchParams.after = params.time.after;
  }

  if (params.time?.before) {
    searchParams.before = params.time.before;
  }

  if (typeof params.limit === "number") {
    searchParams.limit = params.limit;
  }

  return searchParams;
}

function formatSearchResults(results: SearchSessionResult[]): string {
  return results
    .flatMap((result, index) => formatSearchResult(result, index + 1))
    .join("\n")
    .trim();
}

function formatSearchResult(result: SearchSessionResult, index: number): string[] {
  const lines = [
    `### ${index}. ${result.sessionName || "(unnamed session)"}`,
    `session: ${result.sessionId}`,
    `path: ${result.sessionPath}`,
    `cwd: ${result.cwd}`,
    `updated: ${result.modifiedAt}`,
    `score: ${result.score.toFixed(2)} / hits: ${result.hitCount}`,
  ];

  if (result.matchedFiles.length > 0) {
    lines.push(`matched_files: ${result.matchedFiles.join(", ")}`);
  }

  if (result.snippet) {
    lines.push(`> ${result.snippet}`);
  }

  lines.push("");
  return lines;
}
