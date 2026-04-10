import { Type } from "@sinclair/typebox";
import type Database from "better-sqlite3";
import type { FileTouchOp, FileTouchSource, PathScope } from "../../session-search/normalize.js";
import { safeParseTypeBoxJson } from "../typebox.js";

export const INDEX_SCHEMA_VERSION = 7;

export type SessionOrigin = "handoff" | "fork" | "unknown_child";
export type SessionLineageRelation =
  | "parent"
  | "ancestor"
  | "child"
  | "descendant"
  | "sibling"
  | "ancestor_sibling";

export interface SessionRow {
  sessionId: string;
  sessionPath: string;
  sessionName: string;
  firstUserPrompt?: string | undefined;
  cwd: string;
  repoRoots: string[];
  startedAt: string;
  modifiedAt: string;
  messageCount: number;
  entryCount: number;
  parentSessionPath?: string | undefined;
  parentSessionId?: string | undefined;
  sessionOrigin?: SessionOrigin | undefined;
  handoffGoal?: string | undefined;
  handoffNextTask?: string | undefined;
}

export interface SessionLineageRow {
  sessionId: string;
  sessionPath: string;
  sessionName: string;
  firstUserPrompt?: string | undefined;
  cwd: string;
  repoRoots: string[];
  modifiedAt: string;
  parentSessionPath?: string | undefined;
  parentSessionId?: string | undefined;
  sessionOrigin?: SessionOrigin | undefined;
  handoffGoal?: string | undefined;
  handoffNextTask?: string | undefined;
}

export interface SessionRelatedSessionRow extends SessionLineageRow {
  relation: SessionLineageRelation;
  distance: number;
}

export interface SessionTextChunkRow {
  id?: number | undefined;
  sessionId: string;
  entryId?: string | undefined;
  entryType: string;
  role?: string | undefined;
  ts: string;
  sourceKind: string;
  text: string;
}

export interface SessionFileTouchRow {
  id?: number | undefined;
  sessionId: string;
  entryId?: string | undefined;
  op: FileTouchOp;
  source: FileTouchSource;
  rawPath: string;
  absPath?: string | undefined;
  cwdRelPath?: string | undefined;
  repoRoot?: string | undefined;
  repoRelPath?: string | undefined;
  basename: string;
  pathScope: PathScope;
  ts: string;
}

export interface SearchSessionsParams {
  query?: string | undefined;
  cwd?: string | undefined;
  repo?: string | undefined;
  after?: string | undefined;
  before?: string | undefined;
  touched?: string[] | undefined;
  limit?: number | undefined;
}

export interface SearchSessionResult {
  sessionId: string;
  sessionName: string;
  sessionPath: string;
  cwd: string;
  repoRoots: string[];
  startedAt: string;
  modifiedAt: string;
  messageCount: number;
  parentSessionPath?: string | undefined;
  parentSessionId?: string | undefined;
  firstUserPrompt?: string | undefined;
  sessionOrigin?: SessionOrigin | undefined;
  handoffGoal?: string | undefined;
  handoffNextTask?: string | undefined;
  snippet: string;
  matchedFiles: string[];
  score: number;
  hitCount: number;
}

export interface SessionIndexStatus {
  dbPath: string;
  exists: boolean;
  schemaVersion?: number | undefined;
  sessionCount?: number | undefined;
  lastFullReindexAt?: string | undefined;
}

export type SessionIndexDatabase = Database.Database;

export const NULLABLE_STRING_SCHEMA = Type.Union([Type.String(), Type.Null()]);
export const SESSION_ORIGIN_SCHEMA = Type.Union([
  Type.Literal("handoff"),
  Type.Literal("fork"),
  Type.Literal("unknown_child"),
]);
export const SESSION_LINEAGE_RELATION_SCHEMA = Type.Union([
  Type.Literal("parent"),
  Type.Literal("ancestor"),
  Type.Literal("child"),
  Type.Literal("descendant"),
  Type.Literal("sibling"),
  Type.Literal("ancestor_sibling"),
]);
export const ROW_COUNT_SCHEMA = Type.Object({
  count: Type.Number(),
});
export const METADATA_ROW_SCHEMA = Type.Object({
  value: Type.String(),
});

export function parseRepoRoots(value: string): string[] {
  return safeParseTypeBoxJson(Type.Array(Type.String()), value) ?? [];
}

export function escapeLikePrefix(value: string): string {
  return value.replace(/[%_]/g, "\\$&");
}

export function normalizeTimeFilter(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return undefined;
  }

  return date.toISOString();
}

export function sanitizeFilterValues(values?: string[]): string[] {
  if (!values) {
    return [];
  }

  return values.map((value) => value.trim()).filter((value) => value.length > 0);
}

export function boostIndependentHits(hitCount: number): number {
  return hitCount > 1 ? (hitCount - 1) * 0.75 : 0;
}

export function buildFtsQuery(query: string): string | undefined {
  const trimmed = query.trim();
  if (!trimmed) {
    return undefined;
  }

  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    const exact = sanitizeFtsToken(trimmed.slice(1, -1));
    return exact ? quoteFtsToken(exact) : undefined;
  }

  const tokens = tokenizeSearchTerms(trimmed);
  if (tokens.length === 0) {
    return undefined;
  }

  return tokens.map(quoteFtsPrefixToken).join(" AND ");
}

export function tokenizeSearchTerms(query: string): string[] {
  return query
    .split(/\s+/)
    .flatMap((token) => sanitizeFtsToken(token).split(/\s+/))
    .filter((token) => token.length > 0);
}

export function sanitizeFtsToken(token: string): string {
  return token.replace(/[^A-Za-z0-9_]+/g, " ").trim();
}

export function quoteFtsToken(token: string): string {
  return `"${token.replace(/"/g, '""')}"`;
}

export function quoteFtsPrefixToken(token: string): string {
  return `${quoteFtsToken(token)}*`;
}

export function compactSearchValue(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function compactSessionId(value: string): string {
  return value.toLowerCase().replace(/-/g, "");
}
