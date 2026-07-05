import { describe, expect, it } from "vitest";
import { SearchQuerySyntaxError } from "../extensions/shared/session-index/query/ast.ts";
import { compileSearchQuery } from "../extensions/shared/session-index/query/compiler.ts";

function expectCompiled(
  query: string,
  expected: {
    match: string;
    relaxedMatch?: string | undefined;
    excludes?: string[];
    positiveTerms?: string[];
  },
): void {
  expect(compileSearchQuery(query)).toEqual({
    match: expected.match,
    relaxedMatch: expected.relaxedMatch,
    excludes: expected.excludes ?? [],
    positiveTerms: expected.positiveTerms ?? expect.any(Array),
  });
}

describe("session search query compiler", () => {
  it("compiles implicit and explicit boolean expressions", () => {
    expectCompiled("sqlite ranking", {
      match: '("sqlite"* AND "ranking"*)',
      relaxedMatch: '("sqlite"* OR "ranking"*)',
      positiveTerms: ["sqlite", "ranking"],
    });
    expectCompiled("sqlite AND (ranking OR bm25)", {
      match: '("sqlite"* AND ("ranking"* OR "bm25"*))',
      positiveTerms: ["sqlite", "ranking", "bm25"],
    });
    expectCompiled('(sqlite OR fts5) AND "bm25"', {
      match: '(("sqlite"* OR "fts5"*) AND "bm25")',
      positiveTerms: ["sqlite", "fts5", "bm25"],
    });
  });

  it("preserves paths and hyphenated terms as quoted FTS phrases", () => {
    expectCompiled("extensions/session-search.ts session-handoff query*", {
      match: '("extensions/session-search.ts"* AND "session-handoff"* AND "query"*)',
      relaxedMatch: '("extensions/session-search.ts"* OR "session-handoff"* OR "query"*)',
      positiveTerms: ["extensions/session-search.ts", "session-handoff", "query"],
    });
  });

  it("keeps quoted terms exact unless the quote has a trailing prefix marker", () => {
    expectCompiled('"sqlite" "session search" "query plan"*', {
      match: '("sqlite" AND "session search" AND "query plan"*)',
      positiveTerms: ["sqlite", "session search", "query plan"],
    });
  });

  it("only relaxes adjacent unquoted term runs", () => {
    expectCompiled("foo AND bar baz fud", {
      match: '("foo"* AND ("bar"* AND "baz"* AND "fud"*))',
      relaxedMatch: '("foo"* AND ("bar"* OR "baz"* OR "fud"*))',
      positiveTerms: ["foo", "bar", "baz", "fud"],
    });
    expectCompiled("foo AND bar -baz fud", {
      match: '("foo"* AND "bar"* AND "fud"*)',
      excludes: ['"baz"*'],
      positiveTerms: ["foo", "bar", "fud"],
    });
    expectCompiled('"session search" ranking cleanup', {
      match: '("session search" AND ("ranking"* AND "cleanup"*))',
      relaxedMatch: '("session search" AND ("ranking"* OR "cleanup"*))',
      positiveTerms: ["session search", "ranking", "cleanup"],
    });
    expectCompiled("(a b) OR c", {
      match: '(("a"* AND "b"*) OR "c"*)',
      relaxedMatch: '(("a"* OR "b"*) OR "c"*)',
      positiveTerms: ["a", "b", "c"],
    });
  });

  it("extracts top-level negation into session-level excludes", () => {
    expectCompiled("sqlite AND (ranking OR bm25) -schema", {
      match: '("sqlite"* AND ("ranking"* OR "bm25"*))',
      excludes: ['"schema"*'],
      positiveTerms: ["sqlite", "ranking", "bm25"],
    });
    expectCompiled("sqlite AND NOT schema", {
      match: '"sqlite"*',
      excludes: ['"schema"*'],
      positiveTerms: ["sqlite"],
    });
    expectCompiled("NOT schema sqlite", {
      match: '"sqlite"*',
      excludes: ['"schema"*'],
      positiveTerms: ["sqlite"],
    });
  });

  it("rejects negative-only and nested-negation queries", () => {
    expect(() => compileSearchQuery("-schema")).toThrow(SearchQuerySyntaxError);
    expect(() => compileSearchQuery("NOT schema")).toThrow(SearchQuerySyntaxError);
    expect(() => compileSearchQuery("sqlite OR -schema")).toThrow(SearchQuerySyntaxError);
    expect(() => compileSearchQuery("(sqlite -schema) OR bm25")).toThrow(SearchQuerySyntaxError);
  });

  it("rejects malformed queries before SQLite sees them", () => {
    expect(() => compileSearchQuery('foo" OR rowid:*')).toThrow(SearchQuerySyntaxError);
    expect(() => compileSearchQuery("(sqlite OR bm25")).toThrow(SearchQuerySyntaxError);
    expect(() => compileSearchQuery("foo*bar")).toThrow(SearchQuerySyntaxError);
  });
});
