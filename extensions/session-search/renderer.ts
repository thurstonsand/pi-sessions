import path from "node:path";
import type {
  AgentToolResult,
  Theme,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { type Component, getKeybindings, type Keybinding, Text } from "@earendil-works/pi-tui";
import {
  stripSearchSnippetMarkers,
  transformSearchSnippetMatches,
} from "../shared/search-snippet.ts";
import type { SearchSessionResult } from "../shared/session-index/index.ts";
import { formatSessionTitleOrShortId } from "../shared/session-ui.ts";
import type { SessionSearchToolDetails, SessionSearchToolParams } from "./tool-contract.ts";

const COLLAPSED_RESULT_PREVIEW_ROWS = 6;

interface SessionSearchRenderContext {
  isError: boolean;
}

export function renderSessionSearchResult(
  result: AgentToolResult<unknown>,
  { expanded, isPartial }: ToolRenderResultOptions,
  theme: Theme,
  context: SessionSearchRenderContext,
): Component {
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
  lines.push(...formatSessionSearchPanelResults(details.results, details.params, expanded, theme));
  return new Text(lines.join("\n"), 0, 0);
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

function formatOverflowHint(remaining: number, total: number, theme: Theme): string {
  return `${theme.fg("muted", `... (${remaining} more lines, ${total} total,`)} ${theme.fg(
    "dim",
    formatKeyHint("app.tools.expand"),
  )}${theme.fg("muted", " to expand)")}`;
}

function formatKeyHint(keybinding: Keybinding): string {
  return getKeybindings().getKeys(keybinding).join("/");
}
