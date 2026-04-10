import path from "node:path";
import { type Static, Type } from "@sinclair/typebox";
import {
  type FileTouchOp,
  matchesRepoRoot,
  normalizeSearchPath,
} from "../../session-search/normalize.js";
import { parseTypeBoxRows } from "../typebox.js";
import {
  boostIndependentHits,
  buildFtsQuery,
  compactSearchValue,
  compactSessionId,
  escapeLikePrefix,
  NULLABLE_STRING_SCHEMA,
  normalizeTimeFilter,
  parseRepoRoots,
  SESSION_ORIGIN_SCHEMA,
  type SearchSessionResult,
  type SearchSessionsParams,
  type SessionIndexDatabase,
  sanitizeFilterValues,
  tokenizeSearchTerms,
} from "./common.js";

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
  snippet: Type.String(),
  rank: Type.Number(),
  entryId: NULLABLE_STRING_SCHEMA,
  sourceKind: Type.String(),
});

type SearchChunkRow = Static<typeof SEARCH_CHUNK_ROW_SCHEMA>;

const FILE_TOUCH_MATCH_ROW_SCHEMA = Type.Object({
  sessionId: Type.String(),
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
  limit: number | undefined;
  query: string | undefined;
}

interface FileMatchSummary {
  matchedFiles: string[];
}

interface FileMatchAccumulator {
  matchedFiles: Set<string>;
  evidenceKeys: Set<string>;
}

interface FilePathMatch {
  displayPath: string;
  score: number;
}

interface SearchResultAccumulator {
  result: SearchSessionResult;
  evidenceKeys: Set<string>;
  snippetScore: number;
}

const SESSION_ID_EXACT_SCORE = 1_500;
const SESSION_ID_PREFIX_SCORE = 1_250;
const SESSION_ID_SUBSTRING_SCORE = 1_000;
const RECENCY_BASE_SCORE = 220;
const SESSION_NAME_SCORE = 80;
const HANDOFF_NEXT_TASK_SCORE = 60;
const HANDOFF_GOAL_SCORE = 50;
const DEFAULT_TEXT_SCORE = 20;

export function searchSessions(
  db: SessionIndexDatabase,
  params: SearchSessionsParams,
  _options?: { defaultLimit?: number | undefined },
): SearchSessionResult[] {
  const filters = buildSearchFilters(params);
  const fileMatches = hasFileFilters(filters)
    ? collectFileMatches(getCandidateFileTouches(db, filters), filters)
    : new Map<string, FileMatchSummary>();
  const candidates = applySessionFilters(
    getFilteredSessionCandidates(db, filters),
    filters,
    fileMatches,
  );

  if (candidates.length === 0) {
    return [];
  }

  return filters.query
    ? limitSearchResults(searchFilteredSessions(db, candidates, fileMatches, filters), filters)
    : limitSearchResults(browseFilteredSessions(candidates, fileMatches), filters);
}

function buildSearchFilters(params: SearchSessionsParams): SearchFilters {
  const cwd = params.cwd?.trim();

  return {
    after: normalizeTimeFilter(params.after),
    before: normalizeTimeFilter(params.before),
    cwd,
    cwdLike: cwd ? `${escapeLikePrefix(cwd)}%` : undefined,
    repo: params.repo?.trim(),
    touched: sanitizeFilterValues(params.touched),
    limit: params.limit,
    query: params.query?.trim(),
  };
}

function getFilteredSessionCandidates(
  db: SessionIndexDatabase,
  filters: SearchFilters,
): SessionListRow[] {
  return parseTypeBoxRows(
    SESSION_LIST_ROW_SCHEMA,
    db
      .prepare(
        `
          SELECT
            session_id as sessionId,
            session_name as sessionName,
            session_path as sessionPath,
            cwd,
            repo_roots_json as repoRootsJson,
            created_ts as startedAt,
            modified_ts as modifiedAt,
            message_count as messageCount,
            parent_session_path as parentSessionPath,
            parent_session_id as parentSessionId,
            first_user_prompt as firstUserPrompt,
            session_origin as sessionOrigin,
            handoff_goal as handoffGoal,
            handoff_next_task as handoffNextTask
          FROM sessions
          WHERE (? IS NULL OR modified_ts >= ?)
            AND (? IS NULL OR created_ts <= ?)
            AND (? IS NULL OR cwd = ? OR cwd LIKE ? ESCAPE '\\')
          ORDER BY modified_ts DESC
        `,
      )
      .all(...getSearchFilterBindings(filters)),
    "Invalid recent session rows",
  );
}

function applySessionFilters(
  rows: SessionListRow[],
  filters: SearchFilters,
  fileMatches: Map<string, FileMatchSummary>,
): SessionListRow[] {
  return rows.filter((row) => {
    const repoQuery = filters.repo;
    if (
      repoQuery &&
      !parseRepoRoots(row.repoRootsJson).some((repoRoot) => matchesRepoRoot(repoRoot, repoQuery))
    ) {
      return false;
    }

    if (hasFileFilters(filters) && !fileMatches.has(row.sessionId)) {
      return false;
    }

    return true;
  });
}

function browseFilteredSessions(
  rows: SessionListRow[],
  fileMatches: Map<string, FileMatchSummary>,
): SearchSessionResult[] {
  return rows.map((row) => buildSearchResult(row, getDefaultSearchSnippet(row), 0, 0, fileMatches));
}

function searchFilteredSessions(
  db: SessionIndexDatabase,
  candidates: SessionListRow[],
  fileMatches: Map<string, FileMatchSummary>,
  filters: SearchFilters,
): SearchSessionResult[] {
  const candidateById = new Map(
    candidates.map((candidate, index) => [candidate.sessionId, { candidate, index }]),
  );
  const accumulators = new Map<string, SearchResultAccumulator>();
  const queryTokens = tokenizeSessionIdQuery(filters.query ?? "");

  for (const [sessionId, candidate] of candidateById.entries()) {
    const sessionIdEvidence = getSessionIdEvidence(queryTokens, sessionId);
    if (sessionIdEvidence === undefined) {
      continue;
    }

    const accumulator = ensureSearchAccumulator(
      accumulators,
      candidate.candidate,
      candidate.index,
      fileMatches,
    );
    addSearchEvidence(accumulator, "session_id", sessionIdEvidence, undefined, 0);
  }

  for (const row of getTextMatchRows(db, filters)) {
    if (row.sourceKind === "session_id") {
      continue;
    }

    const candidate = candidateById.get(row.sessionId);
    if (!candidate) {
      continue;
    }

    const sourceWeight = getSearchSourceWeight(row.sourceKind);
    const accumulator = ensureSearchAccumulator(
      accumulators,
      candidate.candidate,
      candidate.index,
      fileMatches,
    );
    addSearchEvidence(
      accumulator,
      getSearchEvidenceKey(row),
      sourceWeight,
      selectSearchSnippet(row),
      sourceWeight,
    );
  }

  return [...accumulators.values()]
    .map(({ result }) => ({
      ...result,
      score: result.score + boostIndependentHits(result.hitCount),
    }))
    .sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }

      return b.modifiedAt.localeCompare(a.modifiedAt);
    });
}

function getTextMatchRows(db: SessionIndexDatabase, filters: SearchFilters): SearchChunkRow[] {
  const match = buildFtsQuery(filters.query ?? "");
  if (!match) {
    return [];
  }

  return parseTypeBoxRows(
    SEARCH_CHUNK_ROW_SCHEMA,
    db
      .prepare(
        `
        SELECT
          s.session_id as sessionId,
          s.session_name as sessionName,
          s.session_path as sessionPath,
          s.cwd as cwd,
          s.repo_roots_json as repoRootsJson,
          s.created_ts as startedAt,
          s.modified_ts as modifiedAt,
          s.message_count as messageCount,
          s.parent_session_path as parentSessionPath,
          s.parent_session_id as parentSessionId,
          s.first_user_prompt as firstUserPrompt,
          s.session_origin as sessionOrigin,
          s.handoff_goal as handoffGoal,
          s.handoff_next_task as handoffNextTask,
          snippet(session_text_chunks_fts, 2, '[', ']', ' … ', 12) as snippet,
          bm25(session_text_chunks_fts) as rank,
          c.entry_id as entryId,
          c.source_kind as sourceKind
        FROM session_text_chunks_fts
        JOIN session_text_chunks c ON c.id = CAST(session_text_chunks_fts.chunk_id AS INTEGER)
        JOIN sessions s ON s.session_id = c.session_id
        WHERE session_text_chunks_fts MATCH ?
          AND (? IS NULL OR s.modified_ts >= ?)
          AND (? IS NULL OR s.created_ts <= ?)
          AND (? IS NULL OR s.cwd = ? OR s.cwd LIKE ? ESCAPE '\\')
        ORDER BY rank ASC, s.modified_ts DESC
      `,
      )
      .all(match, ...getSearchFilterBindings(filters)),
    "Invalid text search rows",
  );
}

function getCandidateFileTouches(
  db: SessionIndexDatabase,
  filters: SearchFilters,
): FileTouchMatchRow[] {
  return parseTypeBoxRows(
    FILE_TOUCH_MATCH_ROW_SCHEMA,
    db
      .prepare(
        `
          SELECT
            f.session_id as sessionId,
            f.raw_path as rawPath,
            f.abs_path as absPath,
            f.cwd_rel_path as cwdRelPath,
            f.repo_rel_path as repoRelPath,
            f.basename as basename,
            f.op as op
          FROM session_file_touches f
          JOIN sessions s ON s.session_id = f.session_id
          WHERE (? IS NULL OR s.modified_ts >= ?)
            AND (? IS NULL OR s.created_ts <= ?)
            AND (? IS NULL OR s.cwd = ? OR s.cwd LIKE ? ESCAPE '\\')
        `,
      )
      .all(...getSearchFilterBindings(filters)),
    "Invalid file touch match rows",
  );
}

function collectFileMatches(
  rows: FileTouchMatchRow[],
  filters: SearchFilters,
): Map<string, FileMatchSummary> {
  const accumulators = new Map<string, FileMatchAccumulator>();

  for (const query of filters.touched) {
    for (const row of rows) {
      if (!matchesTouchedFileOp(row.op)) {
        continue;
      }

      const fileMatch = matchFileTouch(row, query);
      if (!fileMatch) {
        continue;
      }

      const accumulator = getFileMatchAccumulator(accumulators, row.sessionId);
      const evidenceKey = `${normalizeSearchPath(query)}:${fileMatch.displayPath}`;
      if (accumulator.evidenceKeys.has(evidenceKey)) {
        continue;
      }

      accumulator.evidenceKeys.add(evidenceKey);
      accumulator.matchedFiles.add(fileMatch.displayPath);
    }
  }

  return new Map(
    [...accumulators.entries()].map(([sessionId, accumulator]) => [
      sessionId,
      {
        matchedFiles: [...accumulator.matchedFiles].sort(),
      },
    ]),
  );
}

function limitSearchResults(
  results: SearchSessionResult[],
  filters: SearchFilters,
): SearchSessionResult[] {
  return typeof filters.limit === "number" ? results.slice(0, filters.limit) : results;
}

function ensureSearchAccumulator(
  accumulators: Map<string, SearchResultAccumulator>,
  row: SessionListRow,
  recencyIndex: number,
  fileMatches: Map<string, FileMatchSummary>,
): SearchResultAccumulator {
  const existing = accumulators.get(row.sessionId);
  if (existing) {
    return existing;
  }

  const nextAccumulator: SearchResultAccumulator = {
    result: buildSearchResult(
      row,
      getDefaultSearchSnippet(row),
      getRecencyScore(recencyIndex),
      0,
      fileMatches,
    ),
    evidenceKeys: new Set<string>(),
    snippetScore: 0,
  };
  accumulators.set(row.sessionId, nextAccumulator);
  return nextAccumulator;
}

function addSearchEvidence(
  accumulator: SearchResultAccumulator,
  evidenceKey: string,
  score: number,
  snippet: string | undefined,
  snippetScore: number,
): void {
  if (accumulator.evidenceKeys.has(evidenceKey)) {
    return;
  }

  accumulator.evidenceKeys.add(evidenceKey);
  accumulator.result.score += score;
  accumulator.result.hitCount += 1;

  if (snippet && snippetScore >= accumulator.snippetScore) {
    accumulator.result.snippet = snippet;
    accumulator.snippetScore = snippetScore;
  }
}

function getSearchEvidenceKey(row: SearchChunkRow): string {
  return row.entryId ? `${row.entryId}:${row.sourceKind}` : `${row.sourceKind}:${row.snippet}`;
}

function buildSearchResult(
  row: SessionListRow | SearchChunkRow,
  snippet: string,
  score: number,
  hitCount: number,
  fileMatches: Map<string, FileMatchSummary> = new Map(),
): SearchSessionResult {
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
    snippet,
    matchedFiles: fileMatches.get(row.sessionId)?.matchedFiles ?? [],
    score,
    hitCount,
  };
}

function getDefaultSearchSnippet(row: SessionListRow | SearchChunkRow): string {
  return row.handoffNextTask || row.handoffGoal || row.sessionName || row.cwd;
}

function selectSearchSnippet(row: SearchChunkRow): string | undefined {
  return row.sourceKind === "session_id" ? undefined : row.snippet;
}

function getSearchSourceWeight(sourceKind: string): number {
  switch (sourceKind) {
    case "session_name":
      return SESSION_NAME_SCORE;
    case "handoff_next_task":
      return HANDOFF_NEXT_TASK_SCORE;
    case "handoff_goal":
      return HANDOFF_GOAL_SCORE;
    default:
      return DEFAULT_TEXT_SCORE;
  }
}

function tokenizeSessionIdQuery(query: string): string[] {
  const trimmed = query.trim();
  if (!trimmed) {
    return [];
  }

  return [...new Set<string>([trimmed, ...tokenizeSearchTerms(trimmed)])];
}

function getSessionIdEvidence(tokens: string[], sessionId: string): number | undefined {
  if (tokens.length === 0) {
    return undefined;
  }

  const canonicalSessionId = sessionId.toLowerCase();
  const compactSessionIdValue = compactSessionId(sessionId);
  let bestScore: number | undefined;

  for (const token of tokens) {
    const score = getSessionIdEvidenceForToken(token, canonicalSessionId, compactSessionIdValue);
    if (score !== undefined && (bestScore === undefined || score > bestScore)) {
      bestScore = score;
    }
  }

  return bestScore;
}

function getSessionIdEvidenceForToken(
  token: string,
  canonicalSessionId: string,
  compactSessionIdValue: string,
): number | undefined {
  const canonicalToken = token.trim().toLowerCase();
  const compactToken = compactSearchValue(token);

  if (canonicalToken.length >= 8) {
    if (canonicalToken === canonicalSessionId || compactToken === compactSessionIdValue) {
      return SESSION_ID_EXACT_SCORE;
    }

    if (
      canonicalSessionId.startsWith(canonicalToken) ||
      (compactToken.length >= 8 && compactSessionIdValue.startsWith(compactToken))
    ) {
      return SESSION_ID_PREFIX_SCORE + canonicalToken.length;
    }
  }

  if (
    compactToken.length >= 8 &&
    (canonicalSessionId.includes(canonicalToken) || compactSessionIdValue.includes(compactToken))
  ) {
    return SESSION_ID_SUBSTRING_SCORE + compactToken.length;
  }

  return undefined;
}

function getRecencyScore(recencyIndex: number): number {
  return Math.max(1, Math.round(RECENCY_BASE_SCORE / (recencyIndex + 1)));
}

function getSearchFilterBindings(
  filters: SearchFilters,
): [
  string | null,
  string | null,
  string | null,
  string | null,
  string | null,
  string | null,
  string | null,
] {
  return [
    filters.after ?? null,
    filters.after ?? null,
    filters.before ?? null,
    filters.before ?? null,
    filters.cwd ?? null,
    filters.cwd ?? null,
    filters.cwdLike ?? null,
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
    matchedFiles: new Set<string>(),
    evidenceKeys: new Set<string>(),
  };
  accumulators.set(sessionId, nextAccumulator);
  return nextAccumulator;
}

function matchesTouchedFileOp(actualOp: FileTouchOp): boolean {
  return actualOp === "read" || actualOp === "changed";
}

function matchFileTouch(row: FileTouchMatchRow, rawQuery: string): FilePathMatch | undefined {
  const query = normalizeSearchPath(rawQuery);
  if (!query) {
    return undefined;
  }

  if (path.isAbsolute(query)) {
    return matchAbsolutePath(row, query);
  }

  if (query.includes("/")) {
    return matchRelativePath(row, query);
  }

  return row.basename === query
    ? {
        displayPath: row.repoRelPath ?? row.cwdRelPath ?? row.absPath ?? row.rawPath,
        score: 1,
      }
    : undefined;
}

function matchAbsolutePath(row: FileTouchMatchRow, query: string): FilePathMatch | undefined {
  if (!row.absPath) {
    return undefined;
  }

  if (row.absPath === query) {
    return { displayPath: row.absPath, score: 3 };
  }

  return row.absPath.endsWith(query) ? { displayPath: row.absPath, score: 2.5 } : undefined;
}

function matchRelativePath(row: FileTouchMatchRow, query: string): FilePathMatch | undefined {
  const candidates = [row.repoRelPath, row.cwdRelPath].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );

  for (const candidate of candidates) {
    if (candidate === query) {
      return { displayPath: candidate, score: 2.5 };
    }

    if (candidate.endsWith(`/${query}`)) {
      return { displayPath: candidate, score: 2 };
    }
  }

  return undefined;
}

function hasFileFilters(filters: SearchFilters): boolean {
  return filters.touched.length > 0;
}
