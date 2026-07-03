import path from "node:path";
import { type Static, Type } from "typebox";
import { normalizeSearchPath } from "../../session-search/normalize.ts";
import {
  SEARCH_SNIPPET_ELLIPSIS,
  SEARCH_SNIPPET_MATCH_END,
  SEARCH_SNIPPET_MATCH_START,
} from "../search-snippet.ts";
import { parseTypeBoxRows } from "../typebox.ts";
import {
  compactSearchValue,
  compactSessionId,
  escapeLikePrefix,
  NULLABLE_STRING_SCHEMA,
  normalizeTimeFilter,
  parseRepoRoots,
  SESSION_ORIGIN_SCHEMA,
  type SearchSessionResult,
  type SearchSessionsParams,
  type SearchSort,
  type SessionIndexDatabase,
  sanitizeFilterValues,
  tokenizeSearchText,
} from "./common.ts";
import { type CompiledSearchQuery, compileSearchQuery } from "./query/compiler.ts";
import {
  buildTextOverfetchLimit,
  MAX_FILTERED_SESSION_CANDIDATES,
  MAX_SCORING_TEXT_HITS_PER_SESSION,
  MAX_TEXT_EVIDENCE_PER_SESSION,
  normalizeResultLimit,
  type SessionIdMatchKind,
  scoreRecency,
  scoreSessionIdMatch,
  scoreTextHit,
} from "./scoring.ts";

const SESSION_LIST_ROW_SCHEMA = Type.Object({
  sessionId: Type.String(),
  sessionName: Type.String(),
  sessionPath: Type.String(),
  cwd: Type.String(),
  repoRootsJson: Type.String(),
  startedAt: Type.String(),
  modifiedAt: Type.String(),
  messageCount: Type.Number(),
  parentSessionPath: NULLABLE_STRING_SCHEMA,
  parentSessionId: NULLABLE_STRING_SCHEMA,
  firstUserPrompt: NULLABLE_STRING_SCHEMA,
  sessionOrigin: Type.Union([SESSION_ORIGIN_SCHEMA, Type.Null()]),
  handoffGoal: NULLABLE_STRING_SCHEMA,
  handoffNextTask: NULLABLE_STRING_SCHEMA,
});

type SessionListRow = Static<typeof SESSION_LIST_ROW_SCHEMA>;

const SEARCH_CHUNK_ROW_SCHEMA = Type.Object({
  sessionId: Type.String(),
  snippet: Type.String(),
  rank: Type.Number(),
  entryId: NULLABLE_STRING_SCHEMA,
  sourceKind: Type.String(),
});

type SearchChunkRow = Static<typeof SEARCH_CHUNK_ROW_SCHEMA>;

const FILE_TOUCH_MATCH_ROW_SCHEMA = Type.Object({
  sessionId: Type.String(),
  entryId: NULLABLE_STRING_SCHEMA,
  rawPath: Type.String(),
  absPath: NULLABLE_STRING_SCHEMA,
  cwdRelPath: NULLABLE_STRING_SCHEMA,
  repoRelPath: NULLABLE_STRING_SCHEMA,
  basename: Type.String(),
  op: Type.Union([Type.Literal("read"), Type.Literal("changed")]),
});

type FileTouchMatchRow = Static<typeof FILE_TOUCH_MATCH_ROW_SCHEMA>;

interface SearchFilters {
  after: string | undefined;
  before: string | undefined;
  cwd: string | undefined;
  cwdLike: string | undefined;
  repo: string | undefined;
  touched: string[];
  changed: string[];
  limit: number;
  sort: SearchSort | undefined;
  query: string | undefined;
  excludeSessionIds: string[];
}

interface FileFilterQuery {
  query: string;
  normalized: string;
  basename: string;
  op: "touched" | "changed";
}

interface FileMatchSummary {
  evidence: FileTouchEvidence[];
}

interface FileMatchAccumulator {
  evidence: FileTouchEvidence[];
  evidenceKeys: Set<string>;
}

interface FilePathMatch {
  displayPath: string;
}

interface FileTouchEvidence {
  kind: "file_touch";
  op: "read" | "changed";
  query: string;
  path: string;
  entryId?: string | undefined;
}

interface SearchResultAccumulator {
  result: SearchSessionResult;
  evidenceKeys: Set<string>;
  textEvidenceCount: number;
  textScoreContributionCount: number;
  bestSnippetScore: number;
}

interface SqlClause {
  sql: string;
  args: Array<string | number | null>;
}

export function searchSessions(
  db: SessionIndexDatabase,
  params: SearchSessionsParams,
): SearchSessionResult[] {
  const filters = buildSearchFilters(params);
  const compiledQuery = filters.query ? compileSearchQuery(filters.query) : undefined;
  const hasPositiveQuery = compiledQuery !== undefined;
  const fileQueries = buildFileFilterQueries(filters);
  const fileMatches =
    fileQueries.length > 0
      ? collectFileMatches(getCandidateFileTouches(db, filters, fileQueries), fileQueries)
      : new Map<string, FileMatchSummary>();

  if (fileQueries.length > 0 && fileMatches.size === 0) {
    return [];
  }

  const candidates = getFilteredSessionCandidates(db, filters, {
    candidateLimit:
      hasPositiveQuery || fileQueries.length > 0 ? MAX_FILTERED_SESSION_CANDIDATES : filters.limit,
    sort: getBrowseSort(filters),
  }).filter((row) => fileQueries.length === 0 || fileMatches.has(row.sessionId));

  if (candidates.length === 0) {
    return [];
  }

  if (!compiledQuery) {
    return limitBrowseResults(
      candidates.map((row) => buildSearchResult(row, 0, fileMatches)),
      filters,
    );
  }

  const ranked = searchFilteredSessions(db, candidates, fileMatches, filters, compiledQuery);
  const selected = ranked.slice(0, filters.limit);
  return applyDisplaySort(selected, filters, true);
}

function buildSearchFilters(params: SearchSessionsParams): SearchFilters {
  const cwd = params.cwd?.trim();
  const after = normalizeTimeFilter(params.after);
  const before = normalizeTimeFilter(params.before);
  if (after && before && after > before) {
    throw new Error("time.after must be less than or equal to time.before");
  }

  return {
    after,
    before,
    cwd,
    cwdLike: cwd ? `${escapeLikePrefix(cwd)}%` : undefined,
    repo: params.repo?.trim(),
    touched: sanitizeFilterValues(params.touched),
    changed: sanitizeFilterValues(params.changed),
    limit: normalizeResultLimit(params.limit),
    sort: normalizeSort(params.sort),
    query: params.query?.trim() || undefined,
    excludeSessionIds: sanitizeFilterValues(params.excludeSessionIds),
  };
}

function normalizeSort(value: SearchSort | undefined): SearchSort | undefined {
  switch (value) {
    case "relevance":
    case "modified_asc":
    case "modified_desc":
      return value;
    default:
      return undefined;
  }
}

function getFilteredSessionCandidates(
  db: SessionIndexDatabase,
  filters: SearchFilters,
  options: { candidateLimit: number; sort: "modified_desc" | "modified_asc" },
): SessionListRow[] {
  const where = buildSessionWhereClause("s", filters);
  const orderDirection = options.sort === "modified_asc" ? "ASC" : "DESC";

  return parseTypeBoxRows(
    SESSION_LIST_ROW_SCHEMA,
    db
      .prepare(
        `
          SELECT
            s.session_id as sessionId,
            s.session_name as sessionName,
            s.session_path as sessionPath,
            s.cwd,
            s.repo_roots_json as repoRootsJson,
            s.created_ts as startedAt,
            s.modified_ts as modifiedAt,
            s.message_count as messageCount,
            s.parent_session_path as parentSessionPath,
            s.parent_session_id as parentSessionId,
            s.first_user_prompt as firstUserPrompt,
            s.session_origin as sessionOrigin,
            s.handoff_goal as handoffGoal,
            s.handoff_next_task as handoffNextTask
          FROM sessions s
          ${where.sql}
          ORDER BY s.modified_ts ${orderDirection}
          LIMIT ?
        `,
      )
      .all(...where.args, options.candidateLimit),
    "Invalid recent session rows",
  );
}

function searchFilteredSessions(
  db: SessionIndexDatabase,
  candidates: SessionListRow[],
  fileMatches: Map<string, FileMatchSummary>,
  filters: SearchFilters,
  compiledQuery: CompiledSearchQuery,
): SearchSessionResult[] {
  const nowMs = Date.now();
  const candidateById = new Map(candidates.map((candidate) => [candidate.sessionId, candidate]));
  const accumulators = new Map<string, SearchResultAccumulator>();
  const queryTokens = tokenizeSessionIdQuery(filters.query ?? "", compiledQuery.positiveTerms);

  for (const [sessionId, candidate] of candidateById.entries()) {
    const sessionIdEvidence = getSessionIdEvidence(queryTokens, sessionId);
    if (!sessionIdEvidence) {
      continue;
    }

    const accumulator = ensureSearchAccumulator(accumulators, candidate, fileMatches, nowMs);
    addSessionIdEvidence(accumulator, sessionIdEvidence.kind, sessionIdEvidence.score);
  }

  const textRows = getTextMatchRows(
    db,
    filters,
    compiledQuery,
    buildTextOverfetchLimit(filters.limit),
    hasFileFilters(filters) ? new Set(fileMatches.keys()) : undefined,
  );

  textRows.forEach((row, rankIndex) => {
    const candidate = candidateById.get(row.sessionId);
    if (!candidate) {
      return;
    }

    const score = scoreTextHit(row.sourceKind, rankIndex);
    const accumulator = ensureSearchAccumulator(accumulators, candidate, fileMatches, nowMs);
    addTextEvidence(accumulator, row, score);
  });

  return [...accumulators.values()]
    .map(({ result }) => ({
      ...result,
      hitCount: result.evidence.length,
    }))
    .sort(compareByRelevance);
}

function getTextMatchRows(
  db: SessionIndexDatabase,
  filters: SearchFilters,
  compiledQuery: CompiledSearchQuery,
  limit: number,
  allowedSessionIds?: Set<string> | undefined,
): SearchChunkRow[] {
  const where = buildSessionWhereClause("s", filters);
  const allowedSessionClause = buildAllowedSessionClause("s", allowedSessionIds);
  const excludeClause = buildExcludeClause(compiledQuery.excludes);

  return parseTypeBoxRows(
    SEARCH_CHUNK_ROW_SCHEMA,
    db
      .prepare(
        `
        SELECT
          c.session_id as sessionId,
          snippet(session_text_chunks_fts, 0, ?, ?, ?, 16) as snippet,
          bm25(session_text_chunks_fts) as rank,
          c.entry_id as entryId,
          c.source_kind as sourceKind
        FROM session_text_chunks_fts
        JOIN session_text_chunks c ON c.id = session_text_chunks_fts.rowid
        JOIN sessions s ON s.session_id = c.session_id
        ${where.sql}
          ${where.sql ? "AND" : "WHERE"} session_text_chunks_fts MATCH ?
          ${allowedSessionClause.sql}
          ${excludeClause.sql}
        ORDER BY rank ASC, s.modified_ts DESC
        LIMIT ?
      `,
      )
      .all(
        SEARCH_SNIPPET_MATCH_START,
        SEARCH_SNIPPET_MATCH_END,
        SEARCH_SNIPPET_ELLIPSIS,
        ...where.args,
        compiledQuery.match,
        ...allowedSessionClause.args,
        ...excludeClause.args,
        limit,
      ),
    "Invalid text search rows",
  );
}

function getCandidateFileTouches(
  db: SessionIndexDatabase,
  filters: SearchFilters,
  fileQueries: FileFilterQuery[],
): FileTouchMatchRow[] {
  const where = buildSessionWhereClause("s", filters);
  const basenames = [...new Set(fileQueries.map((query) => query.basename))];
  const basenamePlaceholders = basenames.map(() => "?").join(", ");

  return parseTypeBoxRows(
    FILE_TOUCH_MATCH_ROW_SCHEMA,
    db
      .prepare(
        `
          SELECT
            f.session_id as sessionId,
            f.entry_id as entryId,
            f.raw_path as rawPath,
            f.abs_path as absPath,
            f.cwd_rel_path as cwdRelPath,
            f.repo_rel_path as repoRelPath,
            f.basename as basename,
            f.op as op
          FROM session_file_touches f
          JOIN sessions s ON s.session_id = f.session_id
          ${where.sql}
            ${where.sql ? "AND" : "WHERE"} f.basename IN (${basenamePlaceholders})
            AND f.op IN ('read', 'changed')
        `,
      )
      .all(...where.args, ...basenames),
    "Invalid file touch match rows",
  );
}

function collectFileMatches(
  rows: FileTouchMatchRow[],
  fileQueries: FileFilterQuery[],
): Map<string, FileMatchSummary> {
  const accumulators = new Map<string, FileMatchAccumulator>();

  for (const query of fileQueries) {
    for (const row of rows) {
      if (query.basename !== row.basename) {
        continue;
      }

      if (query.op === "changed" && row.op !== "changed") {
        continue;
      }

      const fileMatch = matchFileTouch(row, query.normalized);
      if (!fileMatch) {
        continue;
      }

      const accumulator = getFileMatchAccumulator(accumulators, row.sessionId);
      const evidenceKey = `${query.normalized}:${fileMatch.displayPath}:${row.op}`;
      if (accumulator.evidenceKeys.has(evidenceKey)) {
        continue;
      }

      accumulator.evidenceKeys.add(evidenceKey);
      accumulator.evidence.push({
        kind: "file_touch",
        op: row.op,
        query: query.query,
        path: fileMatch.displayPath,
        entryId: row.entryId ?? undefined,
      });
    }
  }

  return new Map(
    [...accumulators.entries()].map(([sessionId, accumulator]) => [
      sessionId,
      {
        evidence: accumulator.evidence.sort(compareFileEvidence),
      },
    ]),
  );
}

function limitBrowseResults(
  results: SearchSessionResult[],
  filters: SearchFilters,
): SearchSessionResult[] {
  return applyDisplaySort(results, filters, false).slice(0, filters.limit);
}

function applyDisplaySort(
  results: SearchSessionResult[],
  filters: SearchFilters,
  hasPositiveQuery: boolean,
): SearchSessionResult[] {
  const sort = filters.sort ?? (hasPositiveQuery ? "relevance" : "modified_desc");
  if (sort === "modified_asc") {
    return [...results].sort((a, b) => a.modifiedAt.localeCompare(b.modifiedAt));
  }
  if (sort === "modified_desc" || (!hasPositiveQuery && sort === "relevance")) {
    return [...results].sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
  }
  return results;
}

function ensureSearchAccumulator(
  accumulators: Map<string, SearchResultAccumulator>,
  row: SessionListRow,
  fileMatches: Map<string, FileMatchSummary>,
  nowMs: number,
): SearchResultAccumulator {
  const existing = accumulators.get(row.sessionId);
  if (existing) {
    return existing;
  }

  const nextAccumulator: SearchResultAccumulator = {
    result: buildSearchResult(row, scoreRecency(row.modifiedAt, nowMs), fileMatches),
    evidenceKeys: new Set<string>(),
    textEvidenceCount: 0,
    textScoreContributionCount: 0,
    bestSnippetScore: Number.NEGATIVE_INFINITY,
  };
  accumulators.set(row.sessionId, nextAccumulator);
  return nextAccumulator;
}

function addSessionIdEvidence(
  accumulator: SearchResultAccumulator,
  match: SessionIdMatchKind,
  score: number,
): void {
  const evidenceKey = `session_id:${match}`;
  if (accumulator.evidenceKeys.has(evidenceKey)) {
    return;
  }

  accumulator.evidenceKeys.add(evidenceKey);
  accumulator.result.score += score;
  accumulator.result.evidence.push({ kind: "session_id", match, score });
}

function addTextEvidence(
  accumulator: SearchResultAccumulator,
  row: SearchChunkRow,
  score: number,
): void {
  const evidenceKey = getTextEvidenceKey(row);
  if (accumulator.evidenceKeys.has(evidenceKey)) {
    return;
  }

  accumulator.evidenceKeys.add(evidenceKey);

  if (accumulator.textScoreContributionCount < MAX_SCORING_TEXT_HITS_PER_SESSION) {
    accumulator.result.score += score;
    accumulator.textScoreContributionCount += 1;
  }

  if (accumulator.textEvidenceCount < MAX_TEXT_EVIDENCE_PER_SESSION) {
    accumulator.result.evidence.push({
      kind: "text",
      sourceKind: row.sourceKind,
      snippet: row.snippet,
      score,
      entryId: row.entryId ?? undefined,
    });
    accumulator.textEvidenceCount += 1;
  }

  if (score > accumulator.bestSnippetScore) {
    accumulator.result.snippet = row.snippet;
    accumulator.bestSnippetScore = score;
  }
}

function getTextEvidenceKey(row: SearchChunkRow): string {
  return row.entryId ? `${row.entryId}:${row.sourceKind}` : `${row.sourceKind}:${row.snippet}`;
}

function buildSearchResult(
  row: SessionListRow,
  score: number,
  fileMatches: Map<string, FileMatchSummary>,
): SearchSessionResult {
  const fileEvidence = fileMatches.get(row.sessionId)?.evidence ?? [];
  return {
    sessionId: row.sessionId,
    sessionName: row.sessionName,
    sessionPath: row.sessionPath,
    cwd: row.cwd,
    repoRoots: parseRepoRoots(row.repoRootsJson),
    startedAt: row.startedAt,
    modifiedAt: row.modifiedAt,
    messageCount: row.messageCount,
    parentSessionPath: row.parentSessionPath ?? undefined,
    parentSessionId: row.parentSessionId ?? undefined,
    firstUserPrompt: row.firstUserPrompt ?? undefined,
    sessionOrigin: row.sessionOrigin ?? undefined,
    handoffGoal: row.handoffGoal ?? undefined,
    handoffNextTask: row.handoffNextTask ?? undefined,
    snippet: "",
    evidence: [...fileEvidence],
    score,
    hitCount: fileEvidence.length,
  };
}

function tokenizeSessionIdQuery(query: string, positiveTerms: string[]): string[] {
  const tokens = new Set<string>();
  if (query.trim()) {
    tokens.add(query.trim());
  }

  for (const term of positiveTerms) {
    tokens.add(term);
    if (term.startsWith("@session:")) {
      tokens.add(term.slice("@session:".length));
    }
    for (const token of tokenizeSearchText(term)) {
      tokens.add(token);
    }
  }

  return [...tokens];
}

function getSessionIdEvidence(tokens: string[], sessionId: string): SessionIdEvidence | undefined {
  if (tokens.length === 0) {
    return undefined;
  }

  const canonicalSessionId = sessionId.toLowerCase();
  const compactSessionIdValue = compactSessionId(sessionId);
  let bestEvidence: SessionIdEvidence | undefined;

  for (const token of tokens) {
    const evidence = getSessionIdEvidenceForToken(token, canonicalSessionId, compactSessionIdValue);
    if (evidence && (!bestEvidence || evidence.score > bestEvidence.score)) {
      bestEvidence = evidence;
    }
  }

  return bestEvidence;
}

interface SessionIdEvidence {
  kind: SessionIdMatchKind;
  score: number;
}

function getSessionIdEvidenceForToken(
  token: string,
  canonicalSessionId: string,
  compactSessionIdValue: string,
): SessionIdEvidence | undefined {
  const canonicalToken = token.trim().toLowerCase();
  const compactToken = compactSearchValue(token);

  if (canonicalToken.length >= 8) {
    if (canonicalToken === canonicalSessionId || compactToken === compactSessionIdValue) {
      return { kind: "exact", score: scoreSessionIdMatch("exact", compactToken.length) };
    }

    if (
      canonicalSessionId.startsWith(canonicalToken) ||
      (compactToken.length >= 8 && compactSessionIdValue.startsWith(compactToken))
    ) {
      return { kind: "prefix", score: scoreSessionIdMatch("prefix", compactToken.length) };
    }
  }

  if (
    compactToken.length >= 8 &&
    (canonicalSessionId.includes(canonicalToken) || compactSessionIdValue.includes(compactToken))
  ) {
    return { kind: "substring", score: scoreSessionIdMatch("substring", compactToken.length) };
  }

  return undefined;
}

function buildSessionWhereClause(alias: string, filters: SearchFilters): SqlClause {
  const conditions: string[] = [];
  const args: Array<string | number | null> = [];

  if (filters.after) {
    conditions.push(`${alias}.modified_ts >= ?`);
    args.push(filters.after);
  }

  if (filters.before) {
    conditions.push(`${alias}.created_ts <= ?`);
    args.push(filters.before);
  }

  if (filters.cwd) {
    conditions.push(`(${alias}.cwd = ? OR ${alias}.cwd LIKE ? ESCAPE '\\')`);
    args.push(filters.cwd, filters.cwdLike ?? `${escapeLikePrefix(filters.cwd)}%`);
  }

  if (filters.excludeSessionIds.length > 0) {
    conditions.push(
      `${alias}.session_id NOT IN (${filters.excludeSessionIds.map(() => "?").join(", ")})`,
    );
    args.push(...filters.excludeSessionIds);
  }

  const repoClause = buildRepoFilterClause(alias, filters.repo);
  if (repoClause) {
    conditions.push(repoClause.sql);
    args.push(...repoClause.args);
  }

  return {
    sql: conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "",
    args,
  };
}

function buildRepoFilterClause(alias: string, rawRepo: string | undefined): SqlClause | undefined {
  if (!rawRepo) {
    return undefined;
  }

  const repo = normalizeSearchPath(rawRepo);
  if (!repo) {
    return undefined;
  }

  if (path.isAbsolute(repo) || repo.includes("/")) {
    return {
      sql: `EXISTS (
        SELECT 1 FROM session_repo_roots r
        WHERE r.session_id = ${alias}.session_id
          AND (r.repo_root = ? OR r.repo_root LIKE ? ESCAPE '\\')
      )`,
      args: [repo, `%${escapeLikePrefix(repo)}`],
    };
  }

  return {
    sql: `EXISTS (
      SELECT 1 FROM session_repo_roots r
      WHERE r.session_id = ${alias}.session_id AND r.repo_basename = ?
    )`,
    args: [repo],
  };
}

function buildAllowedSessionClause(
  alias: string,
  allowedSessionIds: Set<string> | undefined,
): SqlClause {
  if (!allowedSessionIds || allowedSessionIds.size === 0) {
    return { sql: "", args: [] };
  }

  const sessionIds = [...allowedSessionIds];
  return {
    sql: `AND ${alias}.session_id IN (${sessionIds.map(() => "?").join(", ")})`,
    args: sessionIds,
  };
}

function buildExcludeClause(excludes: string[]): SqlClause {
  if (excludes.length === 0) {
    return { sql: "", args: [] };
  }

  return {
    sql: excludes
      .map(
        () => `AND s.session_id NOT IN (
          SELECT excluded_chunks.session_id
          FROM session_text_chunks_fts
          JOIN session_text_chunks excluded_chunks ON excluded_chunks.id = session_text_chunks_fts.rowid
          WHERE session_text_chunks_fts MATCH ?
        )`,
      )
      .join("\n"),
    args: excludes,
  };
}

function buildFileFilterQueries(filters: SearchFilters): FileFilterQuery[] {
  return [
    ...filters.touched.flatMap((query) => buildFileFilterQuery(query, "touched")),
    ...filters.changed.flatMap((query) => buildFileFilterQuery(query, "changed")),
  ];
}

function buildFileFilterQuery(rawQuery: string, op: "touched" | "changed"): FileFilterQuery[] {
  const normalized = normalizeSearchPath(rawQuery);
  if (!normalized) {
    return [];
  }

  return [
    {
      query: rawQuery,
      normalized,
      basename: path.basename(normalized.replace(/[/]+$/, "")) || normalized,
      op,
    },
  ];
}

function getFileMatchAccumulator(
  accumulators: Map<string, FileMatchAccumulator>,
  sessionId: string,
): FileMatchAccumulator {
  const existing = accumulators.get(sessionId);
  if (existing) {
    return existing;
  }

  const nextAccumulator: FileMatchAccumulator = {
    evidence: [],
    evidenceKeys: new Set<string>(),
  };
  accumulators.set(sessionId, nextAccumulator);
  return nextAccumulator;
}

function matchFileTouch(row: FileTouchMatchRow, query: string): FilePathMatch | undefined {
  if (path.isAbsolute(query)) {
    return matchAbsolutePath(row, query);
  }

  if (query.includes("/")) {
    return matchRelativePath(row, query);
  }

  return row.basename === query
    ? {
        displayPath: row.repoRelPath ?? row.cwdRelPath ?? row.absPath ?? row.rawPath,
      }
    : undefined;
}

function matchAbsolutePath(row: FileTouchMatchRow, query: string): FilePathMatch | undefined {
  if (!row.absPath) {
    return undefined;
  }

  if (row.absPath === query || row.absPath.endsWith(query)) {
    return { displayPath: row.absPath };
  }

  return undefined;
}

function matchRelativePath(row: FileTouchMatchRow, query: string): FilePathMatch | undefined {
  const candidates = [row.repoRelPath, row.cwdRelPath].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );

  for (const candidate of candidates) {
    if (candidate === query || candidate.endsWith(`/${query}`)) {
      return { displayPath: candidate };
    }
  }

  return undefined;
}

function compareByRelevance(a: SearchSessionResult, b: SearchSessionResult): number {
  if (b.score !== a.score) {
    return b.score - a.score;
  }

  return b.modifiedAt.localeCompare(a.modifiedAt);
}

function compareFileEvidence(a: FileTouchEvidence, b: FileTouchEvidence): number {
  const pathDiff = a.path.localeCompare(b.path);
  if (pathDiff !== 0) {
    return pathDiff;
  }

  return a.op.localeCompare(b.op);
}

function getBrowseSort(filters: SearchFilters): "modified_desc" | "modified_asc" {
  return filters.sort === "modified_asc" ? "modified_asc" : "modified_desc";
}

function hasFileFilters(filters: SearchFilters): boolean {
  return filters.touched.length > 0 || filters.changed.length > 0;
}
