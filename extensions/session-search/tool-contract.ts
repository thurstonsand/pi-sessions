import type {
  SearchSessionResult,
  SearchSort,
  SessionIndexStatus,
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
  live?: boolean;
}

export interface SessionSearchToolDetails {
  params?: SessionSearchToolParams | undefined;
  results: SearchSessionResult[];
  status?: SessionIndexStatus | undefined;
}
