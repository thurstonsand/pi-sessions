import type {
  SearchSessionResult,
  SearchSort,
  SessionIndexStatus,
  SessionKind,
} from "../shared/session-index/index.ts";
import type { SubagentState } from "../subagents/classify.ts";

export interface SessionSearchToolParams {
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
  kind?: SessionKind;
  relationScope?: "branch" | "tree";
}

export interface SessionSearchScopeDetails {
  matched: number;
  total: number;
}

export interface StartingSearchResult extends SearchSessionResult {
  state: "starting";
}

export interface RelatedSubagentSearchResult extends SearchSessionResult {
  state: SubagentState;
  depth: number;
  onActiveBranch: boolean;
}

export type AnnotatedSearchResult = StartingSearchResult | RelatedSubagentSearchResult;
export type SessionSearchResult = SearchSessionResult | AnnotatedSearchResult;

export interface SessionSearchToolDetails {
  params?: SessionSearchToolParams | undefined;
  results: SessionSearchResult[];
  status?: SessionIndexStatus | undefined;
  scope?: SessionSearchScopeDetails | undefined;
}
