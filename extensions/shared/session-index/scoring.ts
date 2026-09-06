const SESSION_ID_EXACT_SCORE = 100_000;
const SESSION_ID_PREFIX_SCORE = 80_000;
const SESSION_ID_SUBSTRING_SCORE = 60_000;
const RECENCY_MAX_SCORE = 300;
const RECENCY_HALF_LIFE_DAYS = 21;

const TEXT_SOURCE_WEIGHTS = new Map<string, number>([
  ["session_name", 360],
  ["handoff_goal", 300],
  ["user_text", 180],
  ["assistant_text", 150],
  ["bash_command", 140],
  ["tool_result", 110],
  ["bash_output", 90],
]);

export const MAX_SCORING_TEXT_HITS_PER_SESSION = 5;
export const MAX_TEXT_EVIDENCE_PER_SESSION = 20;
export const DEFAULT_SESSION_SEARCH_LIMIT = 50;
export const MAX_SESSION_SEARCH_LIMIT = 500;
export const MIN_TEXT_OVERFETCH_LIMIT = 200;
export const TEXT_OVERFETCH_MULTIPLIER = 25;
export const MAX_TEXT_OVERFETCH_LIMIT = 5_000;

export type SessionIdMatchKind = "exact" | "prefix" | "substring";

export interface SessionIdScore {
  kind: SessionIdMatchKind;
  score: number;
}

export function scoreSessionIdMatch(kind: SessionIdMatchKind, matchedLength = 0): number {
  switch (kind) {
    case "exact":
      return SESSION_ID_EXACT_SCORE;
    case "prefix":
      return SESSION_ID_PREFIX_SCORE + matchedLength;
    case "substring":
      return SESSION_ID_SUBSTRING_SCORE + matchedLength;
  }
}

export function scoreTextHit(sourceKind: string, rankIndex: number): number {
  return getSourceWeight(sourceKind) / (rankIndex + 1);
}

export function scoreRecency(modifiedAt: string, nowMs: number): number {
  const modifiedMs = new Date(modifiedAt).getTime();
  if (Number.isNaN(modifiedMs)) {
    return 0;
  }

  const ageDays = Math.max(0, (nowMs - modifiedMs) / 86_400_000);
  return RECENCY_MAX_SCORE * 0.5 ** (ageDays / RECENCY_HALF_LIFE_DAYS);
}

export function buildTextOverfetchLimit(resultLimit: number): number {
  return Math.min(
    MAX_TEXT_OVERFETCH_LIMIT,
    Math.max(MIN_TEXT_OVERFETCH_LIMIT, resultLimit * TEXT_OVERFETCH_MULTIPLIER),
  );
}

export function normalizeResultLimit(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_SESSION_SEARCH_LIMIT;
  }

  if (!Number.isFinite(value) || value <= 0) {
    throw new Error("limit must be greater than 0");
  }

  return Math.min(MAX_SESSION_SEARCH_LIMIT, Math.trunc(value));
}

function getSourceWeight(sourceKind: string): number {
  return TEXT_SOURCE_WEIGHTS.get(sourceKind) ?? 120;
}
