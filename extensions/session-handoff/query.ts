import path from "node:path";
import {
  getIndexStatus,
  getLineageAutocompleteSessions,
  getRecentAutocompleteSessions,
  getSessionByPath,
  INDEX_SCHEMA_VERSION,
  openIndexDatabase,
  type SessionLineageRelation,
  type SessionLineageRow,
  type SessionRelatedSessionRow,
} from "../session-search/db.js";
import { deriveRepoRootForPath } from "../session-search/normalize.js";

export const SESSION_TOKEN_PREFIX = "@session:";

const RELATIVE_TIME_FORMATTER = new Intl.RelativeTimeFormat("en", {
  numeric: "always",
  style: "narrow",
});

const RELATIVE_TIME_UNITS = [
  ["year", 60 * 60 * 24 * 365],
  ["month", 60 * 60 * 24 * 30],
  ["week", 60 * 60 * 24 * 7],
  ["day", 60 * 60 * 24],
  ["hour", 60 * 60],
  ["minute", 60],
  ["second", 1],
] as const;

export interface HandoffAutocompleteCandidate {
  value: string;
  label: string;
  description?: string | undefined;
  sessionId: string;
  relation?: SessionLineageRelation | undefined;
  distance?: number | undefined;
}

export interface ListHandoffAutocompleteCandidatesOptions {
  currentSessionPath?: string | undefined;
  currentCwd?: string | undefined;
  prefix: string;
  includeAll: boolean;
  indexPath: string;
  limit?: number | undefined;
}

export interface HandoffAutocompleteQueryResult {
  candidates: HandoffAutocompleteCandidate[];
  mode: "default" | "all";
  defaultScopeLabel?: string | undefined;
}

export function listHandoffAutocompleteCandidates(
  options: ListHandoffAutocompleteCandidatesOptions,
): HandoffAutocompleteQueryResult {
  const status = getIndexStatus(options.indexPath);
  if (!status.exists || status.schemaVersion !== INDEX_SCHEMA_VERSION) {
    return { candidates: [], mode: options.includeAll ? "all" : "default" };
  }

  const db = openIndexDatabase(status.dbPath, { create: false });
  try {
    const currentSession = options.currentSessionPath
      ? getSessionByPath(db, options.currentSessionPath)
      : undefined;
    const currentCwd = options.currentCwd ?? currentSession?.cwd;
    const currentRepoRoot = deriveCurrentRepoRoot(currentCwd, currentSession);
    const lineageRows = currentSession
      ? getLineageAutocompleteSessions(db, currentSession.sessionId, options.prefix)
      : [];
    let defaultScopeLabel: string | undefined;
    if (currentRepoRoot) {
      defaultScopeLabel = "current repo";
    } else if (currentCwd) {
      defaultScopeLabel = "current cwd";
    }
    const recentRows = getRecentAutocompleteSessions(db, options.prefix, undefined, {
      excludeSessionId: currentSession?.sessionId,
    });
    const scopedRows = options.includeAll
      ? recentRows
      : getScopedRecentRows(recentRows, currentRepoRoot, currentCwd);
    const rows = combinePinnedRows(lineageRows, scopedRows);

    return {
      candidates: rows.map((row) => buildHandoffAutocompleteCandidate(row)),
      mode: options.includeAll ? "all" : "default",
      defaultScopeLabel,
    };
  } finally {
    db.close();
  }
}

function buildHandoffAutocompleteCandidate(
  row: SessionLineageRow | SessionRelatedSessionRow,
): HandoffAutocompleteCandidate {
  const relation = getRelation(row);
  const distance = getDistance(row);
  const label = buildCandidateLabel(row);
  const description = buildCandidateDescription(row);

  return {
    value: `${SESSION_TOKEN_PREFIX}${row.sessionId}`,
    label,
    description,
    sessionId: row.sessionId,
    relation,
    distance,
  };
}

function buildCandidateLabel(row: SessionLineageRow): string {
  return buildRepoLabel(row) ?? shortSessionId(row.sessionId);
}

function buildCandidateDescription(row: SessionLineageRow): string | undefined {
  const parts = [
    getCandidateContextText(row),
    shortSessionId(row.sessionId),
    formatRelativeModifiedAt(row.modifiedAt),
  ].filter((part): part is string => Boolean(part));

  return parts.length > 0 ? parts.join(" · ") : undefined;
}

function normalizeDisplayText(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : undefined;
}

function getCandidateContextText(row: SessionLineageRow): string | undefined {
  return (
    normalizeDisplayText(row.handoffNextTask) ??
    normalizeDisplayText(row.handoffGoal) ??
    normalizeDisplayText(row.sessionName) ??
    normalizeDisplayText(row.firstUserPrompt)
  );
}

function buildRepoLabel(row: SessionLineageRow): string | undefined {
  for (const repoRoot of row.repoRoots) {
    const normalized = normalizeDisplayText(repoRoot);
    if (normalized) {
      return path.basename(normalized) || normalized;
    }
  }

  const normalizedCwd = normalizeDisplayText(row.cwd);
  if (!normalizedCwd) {
    return undefined;
  }

  return path.basename(normalizedCwd) || normalizedCwd;
}

function shortSessionId(sessionId: string): string {
  return sessionId.slice(0, 8);
}

function formatRelativeModifiedAt(modifiedAt: string): string | undefined {
  const modifiedAtMs = Date.parse(modifiedAt);
  if (Number.isNaN(modifiedAtMs)) {
    return undefined;
  }

  const diffSeconds = Math.round((modifiedAtMs - Date.now()) / 1000);
  const absDiffSeconds = Math.abs(diffSeconds);

  for (const [unit, secondsPerUnit] of RELATIVE_TIME_UNITS) {
    if (absDiffSeconds >= secondsPerUnit || unit === "second") {
      const value =
        absDiffSeconds < secondsPerUnit
          ? 0
          : Math.sign(diffSeconds) * Math.floor(absDiffSeconds / secondsPerUnit);
      return RELATIVE_TIME_FORMATTER.format(value, unit);
    }
  }
}

function combinePinnedRows(
  pinnedRows: SessionRelatedSessionRow[],
  recentRows: SessionLineageRow[],
): Array<SessionLineageRow | SessionRelatedSessionRow> {
  const combined = new Map<string, SessionLineageRow | SessionRelatedSessionRow>();

  for (const row of pinnedRows) {
    combined.set(row.sessionId, row);
  }

  for (const row of recentRows) {
    if (!combined.has(row.sessionId)) {
      combined.set(row.sessionId, row);
    }
  }

  return [...combined.values()];
}

function getScopedRecentRows(
  rows: SessionLineageRow[],
  currentRepoRoot?: string | undefined,
  currentCwd?: string | undefined,
): SessionLineageRow[] {
  if (currentRepoRoot) {
    return rows.filter((row) => row.repoRoots.includes(currentRepoRoot));
  }

  if (currentCwd) {
    return rows.filter((row) => row.cwd === currentCwd);
  }

  return [];
}

function deriveCurrentRepoRoot(
  currentCwd: string | undefined,
  currentSession: SessionLineageRow | undefined,
): string | undefined {
  if (currentCwd) {
    const cwdRepoRoot = deriveRepoRootForPath(currentCwd);
    if (cwdRepoRoot) {
      return cwdRepoRoot;
    }
  }

  return currentSession?.repoRoots[0];
}

function getRelation(
  row: SessionLineageRow | SessionRelatedSessionRow,
): SessionLineageRelation | undefined {
  return "relation" in row && typeof row.relation === "string" ? row.relation : undefined;
}

function getDistance(row: SessionLineageRow | SessionRelatedSessionRow): number | undefined {
  return "distance" in row && typeof row.distance === "number" ? row.distance : undefined;
}
