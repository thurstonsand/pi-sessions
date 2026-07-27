import type {
  SearchSessionResult,
  SearchSort,
  SessionIndexStatus,
  SessionKind,
} from "../shared/session-index/index.ts";

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
  kind?: SessionKind;
}

export type SessionSearchResult = SearchSessionResult;

export interface SessionSearchToolDetails {
  params?: SessionSearchToolParams | undefined;
  results: SessionSearchResult[];
  status?: SessionIndexStatus | undefined;
}
