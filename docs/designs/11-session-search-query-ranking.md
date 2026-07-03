# Session Search Query and Ranking Revision

## Status

Accepted

## Decision Summary

Revise `session_search` and the shared session-reference search backend around a safe custom query parser, SQL-first filtering, relevance-aware ranking, and evidence-rich results. This design intentionally breaks the rebuildable session index schema to fix ranking correctness and query flexibility before adding larger code-search features.

## Problem Statement / Background

The current session search implementation stores useful evidence in SQLite, but the query path is too naive for the way the tool is used. All of the following are verified against `extensions/shared/session-index/search.ts` and `extensions/shared/session-index/common.ts`:

- SQLite BM25 rank is selected and ordered by, but never enters result scoring. Worse, because `addSearchEvidence` replaces the snippet on `snippetScore >= accumulator.snippetScore` and rows arrive best-rank-first, the snippet shown for a session is the *lowest*-ranked chunk among the winning source kind.
- Free-text search is strict `AND` of prefix tokens. Quoting only works when the entire query is one quoted string; embedded phrases and boolean expressions are unsupported.
- Query sanitization (`sanitizeFtsToken`) reduces everything to `[A-Za-z0-9_]` tokens joined with `AND`. A path query like `extensions/session-search.ts` matches sessions containing `extensions`, `session`, `search`, and `ts` *anywhere*, losing all adjacency. (Session references are less affected than paths: the dedicated session-id evidence path does its own tokenization and still prefix-matches on an 8-character UUID segment.)
- Several filters are applied in JavaScript after loading candidate rows: repo matching parses `repo_roots_json` per row, file-touch matching loads every touch row in the time/cwd window and matches paths in JS, and session exclusion filters a JS `Set`. Neither the candidate query nor the FTS query carries a `LIMIT`, and the FTS query duplicates the full session metadata onto every chunk row.
- Ranking signals are ad hoc. Recency is a harmonic decay on the session's *position* in the filtered candidate list (`RECENCY_BASE_SCORE / (index + 1)`), not its age, so the score depends on how many sessions match the filters. Each matching chunk adds a flat per-source weight with no bound, so ~75 matching chunks in one long session (75 × 20) out-scores an exact session-id match (1500).
- The tool returns one snippet per session even when multiple high-signal chunks matched.
- The picker and tool share `searchSessions`, so query semantics improve in one shared layer — but the picker then re-sorts results by lineage priority *above* relevance (`prioritizeSessionResults` in `extensions/session-handoff/query.ts`), so ranking fixes will not surface in picker search mode without a decision here.
- Time filters are asymmetric and misdocumented: `after` bounds `modified_ts` while `before` bounds `created_ts` (interval-overlap semantics), but the tool parameter descriptions say both bound modified time. Separately, `normalizeTimeFilter` silently drops unparseable dates, so an invalid filter widens the search instead of failing.

The goal is not to build a general search engine. The goal is a better local recall tool for Pi sessions: predictable enough for an agent to call, expressive enough for humans, and simple enough to trust.

## Goals

- Use SQLite FTS relevance when ranking text matches.
- Support a small, safe boolean query language for free-text search.
- Preserve no-query chronological browsing for structured searches such as “sessions that changed this file.”
- Push active filters into SQL wherever practical, and bound every SQL result set.
- Replace position-based recency with age-based recency, and bound per-session text contribution.
- Return evidence explaining why a session matched, including multiple text snippets and file-touch evidence.
- Keep the search tool and session reference picker backed by the same shared query layer, and define how picker lineage priority composes with relevance.
- Define time-filter semantics explicitly and fail closed on invalid filter values in the shared layer, not just the tool wrapper.
- Allow breaking session-index schema changes because the index is rebuildable.

## Non-Goals

- Do not add a parser dependency in this revision.
- Do not support Gmail-style `field:value` filters inside free-text query strings in Phase 1.
- Do not add source/role filters to the public tool surface in Phase 1.
- Do not implement negative-only searches in Phase 1.
- Do not index full edit/write payload contents in Phase 1.
- Do not add separate prose/code FTS indexes in Phase 1.
- Do not make the comparison harness a committed product artifact.

## Exposed Shape

### Tool parameters

`session_search` should keep a small structured surface:

```ts
{
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
  sort?: "relevance" | "modified_desc" | "modified_asc";
  limit?: number;
}
```

`files.touched` means read or changed. `files.changed` means changed only. The `session_file_touches` table already stores `op` per row, so `changed` is a trivial SQL predicate. Multiple file entries combine as `OR`, both within and across the two arrays: a session qualifies if any entry matches, which is how multiple `touched` entries behave today.

Time semantics: a session matches when its active interval `[created_ts, modified_ts]` overlaps `[after, before]`. This is what the SQL already does; the parameter descriptions and this doc should say so instead of claiming both bound modified time.

The tool’s `promptGuidelines` currently tell the model “plain text only. Do not use boolean operators like OR/AND, parentheses…”. They must be rewritten alongside this change to document the new grammar, or the model will keep issuing degraded single-term queries.

### Query syntax

Free-text query syntax should support:

```txt
sqlite ranking
sqlite AND ranking
sqlite OR bm25
sqlite -schema
sqlite AND NOT schema
(sqlite OR fts5) AND bm25
"session search"
"session search" ranking
query*
```

Rules:

- An unquoted term is a maximal run of characters excluding whitespace, `(`, `)`, and `"`. Paths, identifiers, and session references such as `@session:<uuid>` lex as single terms.
- `AND`, `OR`, and `NOT` are case-insensitive operator tokens.
- Adjacent positive terms imply `AND`.
- Precedence is negation, then `AND`/adjacency, then `OR`.
- `-term` is shorthand for `NOT term`. `-` begins negation only at a term boundary: start of input, after whitespace, or after `(`. A hyphen inside a term is part of the term, so `session-search` is one term, not `session NOT search`.
- Negation is only valid as a direct child of the top-level conjunction. `foo OR -bar` and `(a -b) OR c` are rejected in Phase 1, because session-level exclusion (Decision 4) is global to the query and cannot represent nested negation.
- Unquoted terms default to prefix matching: `sqlite` compiles to an FTS prefix term.
- Quoted terms are exact, including single-word quotes: `"sqlite"` means exact term, not prefix.
- Only trailing `*` is supported for explicit prefix terms; `"foo bar"*` is valid FTS5 and makes the last phrase token a prefix.
- Raw user text is never passed directly to FTS5 `MATCH`.

### Result shape

Results should return evidence, not just a single snippet:

```ts
type SessionSearchEvidence =
  | {
      kind: "text";
      sourceKind: string;
      snippet: string;
      score: number;
      entryId?: string;
    }
  | {
      kind: "file_touch";
      op: "read" | "changed";
      query: string;
      path: string;
      entryId?: string;
    }
  | {
      kind: "session_id";
      match: "exact" | "prefix" | "substring";
      score: number;
    };
```

The backend may return bounded text evidence, initially up to 20 snippets per session. Rendering should show a smaller preview, such as the top three snippets. The current `matchedFiles: string[]` field folds into `file_touch` evidence rather than living beside it.

Both renderers change with this shape: the tool’s `renderResult`/`formatSearchResultsForModel` in `extensions/session-search.ts`, and the picker’s snippet/title fallbacks in `extensions/session-handoff/query.ts` (`getSessionTitle` falls back through `result.snippet`).

## Design Decisions

### 1. Use a custom parser and compiler

A spike compared TypeScript parser libraries against a small custom parser. No TypeScript library was found that targets SQLite FTS5 `MATCH` syntax directly. Lucene-like parsers such as `liqe` parse too much language, reject useful pi-sessions inputs such as paths and session-reference-like tokens, and still require a custom SQLite FTS compiler. Older libraries preserve too little structure around unary negation.

The chosen path is a small custom lexer/parser/compiler dedicated to the supported grammar. One FTS5 fact shapes the compiler: FTS5 `NOT` is a *binary* set-difference operator; there is no unary `NOT` in `MATCH` syntax. Combined with session-level negation (Decision 4), this means unary negation never reaches `MATCH` at all. The compiler output is:

```ts
interface CompiledQuery {
  match: string;        // positive expression only
  excludes: string[];   // one MATCH string per top-level negation
}
```

Compile rules: unquoted term → `"term"*`; quoted term/phrase → `"..."` (with `""` escaping); explicit trailing `*` preserved. Because every term is emitted quoted and only known operators/parens are emitted between them, the compiled string is injection-safe by construction, and it is still bound as a SQL parameter.

Suggested layout: `extensions/shared/session-index/query/lexer.ts`, `parser.ts` (AST), `compiler.ts`, with scoring isolated in `scoring.ts` so tunable constants live in one place.

Tradeoff: this requires careful tests, but it avoids adopting a broad query language only to reject most of it.

### 2. Treat free-text query parsing and structured filters separately

Phase 1 should not support `repo:`, `changed:`, or other Gmail-style filters inside the free-text query. The Pi tool can pass structured filters directly, and the session reference picker can revisit user-facing filter syntax later.

Tradeoff: human picker search remains less expressive for now, but the core agent-facing tool stays simpler and easier to validate.

### 3. Reject negative-only searches in Phase 1

Positive queries may include negative clauses, such as `sqlite -schema`. Negative-only queries such as `-schema` or `NOT schema` should be rejected in Phase 1.

Negative-only search is still useful as a future browse/filter mode: start from chronological filtered sessions, exclude sessions matching the negative text, and return the remaining sessions. That requires a separate anti-match execution path and should not be mixed into the initial ranking fix.

### 4. Apply negation at session level

For Phase 1, negation should exclude sessions, not just individual FTS rows. `sqlite -schema` means “sessions matching `sqlite`, excluding sessions that match `schema` anywhere in the indexed text.”

The execution is one exclusion subquery per `excludes` entry:

```sql
AND s.session_id NOT IN (
  SELECT c.session_id
  FROM session_text_chunks_fts f
  JOIN session_text_chunks c ON c.id = f.rowid
  WHERE session_text_chunks_fts MATCH :exclude
)
```

Tradeoff: this is stricter than row-level FTS `NOT`, but it matches the user’s mental model for session discovery, and it is what forces the grammar restriction that negation lives only in the top-level conjunction.

### 5. Preserve chronological browse when there is no positive text query

A `session_search` call with no `query` should return sessions matching structured filters in chronological order, newest first by default. This is the path used for searches like “all sessions that touched this file.”

If no positive text query exists, there is no relevance-selected candidate set; chronological sort determines selection.

### 6. Make `sort` display ordering for ranked searches

For positive text searches, result selection should be determined by relevance. If `sort` is specified as `modified_desc` or `modified_asc`, it should reorder the relevance-selected result set for display only. It should not change which sessions are selected.

Defaults:

- Positive text query: `relevance`
- No positive text query: `modified_desc`

The picker needs the same discipline. Today `prioritizeSessionResults` sorts lineage relation (self/parent/child/…) above everything, so in search mode a weak text match on a parent session outranks a strong match elsewhere. With this revision, lineage priority should apply as the primary sort only in browse mode; in search mode it becomes a tiebreak below relevance. Otherwise none of this ranking work reaches the picker.

### 7. Rank by lexical relevance plus product signals

The current implementation selects SQLite BM25 rank but effectively ignores it. The revised ranking should use FTS rank order as the text relevance base, then combine it with product signals:

- session-id match strength
- text relevance from top matching chunks
- source-kind evidence bonuses
- recency
- bounded repeated-hit evidence

SQLite BM25 values should not be added raw to the product score. They are query-local and lower-is-better. The safer approach is rank-position normalization: over the overfetched chunk rows ordered by BM25, chunk *i* contributes `w(sourceKind) × 1/(1 + i)` (or similar), and a session’s text score sums its top K chunks (K ≈ 5) so contribution has diminishing returns and a hard bound.

Recency must be age-based, not position-based. The current `RECENCY_BASE_SCORE / (candidateIndex + 1)` makes a session’s score depend on how many other sessions matched the filters, which is unstable across corpora and filter combinations. Replace it with exponential decay on `modified_ts` age (half-life on the order of weeks, tunable in `scoring.ts`). Recency remains part of the relevance score, not just a final tie-break, because recent sessions are often more likely to be the intended recall target.

Whatever the constants, preserve the invariant that an exact session-id match outranks any accumulation of text evidence. Today that invariant silently fails once a session has enough matching chunks.

### 8. Bound text evidence, repeated-hit contribution, and SQL result sets

A broad query can match many chunks in one long session. Three bounds, all currently missing:

- The FTS chunk query gets `ORDER BY bm25 LIMIT :overfetch` (on the order of `max(200, limit × 25)`), instead of returning every matching row.
- Per-session text contribution is capped by the top-K rule in Decision 7.
- Returned text evidence is capped at 20 entries per selected session, with rendering limited to the top three.

The chunk query should also stop duplicating full session metadata per row: select chunk-level columns plus `session_id` only, and join to the already-loaded candidate rows in JS. Chunks with `source_kind = 'session_id'` stop being indexed into FTS entirely. Nothing consumes them: session-id lookup never goes through FTS — `session_search` matches ids in its dedicated session-id evidence path by direct comparison against candidate rows from the `sessions` table, and `session_ask` resolves exact UUIDs with `getSessionById`. Today these chunks are fetched by the FTS query only to be skipped in JS, and their UUID text pollutes the FTS term statistics.

File-touch evidence should be returned distinctly for selected sessions. It explains filter matches, but it should not automatically become a ranking boost unless a later design says so.

### 9. Break the index schema now

The session index is rebuildable and not the source of truth. Phase 1 may freely bump the schema version and require reindexing.

Expected schema direction:

- Add a normalized `session_repo_roots(session_id, repo_root, repo_basename)` table instead of filtering `repo_roots_json` in JavaScript. `matchesRepoRoot`’s three match forms map to indexed equality on `repo_root` or `repo_basename`, with a suffix `LIKE '%/' || :query` fallback for partial relative paths.
- Move session exclusion (`excludeSessionIds`, which today always carries the current session) into a SQL `NOT IN`.
- Make file filters SQL-first. Every query form ends in a basename and `basename` is already indexed, so at minimum prefilter `session_file_touches` on `basename = ?` (plus `op` for `changed`) and refine the abs/rel path forms in JS; full-SQL matching of the three path forms is optional.
- Set the FTS tokenizer explicitly: `tokenize = "unicode61 remove_diacritics 2 tokenchars '_'"`. Default unicode61 splits on `_`, so identifiers like `source_kind` currently index as two tokens; since the schema is breaking anyway, keep identifiers whole.
- Stop writing `session_id` chunks (`insertSessionIdChunk`/`syncSessionIdChunk` in `store.ts`); session-id matching is served by the `sessions` table (Decision 8).
- Keep one FTS table in Phase 1.

### 10. Keep code-content indexing for a later phase

Phase 1 should not store full `edit.oldText`, `edit.newText`, or `write.content` payloads. That is a useful Phase 2 improvement because it would make search better for code changes, but it is separable from fixing ranking, filtering, and query compilation.

### 11. Commit deterministic tests; keep the tuning harness disposable

Parser, compiler, and ranking-invariant tests are committed unit tests: grammar goldens (input → compiled `{match, excludes}` or rejection), and ordering invariants over a small synthetic corpus (exact session-id beats text accumulation, phrase match beats scattered tokens, newer beats older at equal text score).

A comparison harness for qualitative tuning against the real local index is useful, but it should not become committed production code. It can be a temporary checkout, scratch script, or side-by-side local run comparing current main behavior against the revised implementation.

Tradeoff: this gives practical evidence without creating maintenance burden for a one-off evaluation tool.

### 12. Remove dead search-path code while in here

Small, but each one is a trap for the next change:

- `FileTouchOp` includes `"touched"`, which nothing in `extract.ts` produces, yet `matchesTouchedFileOp` exists solely to filter it out. Drop the variant.
- `matchFileTouch` computes a `FilePathMatch.score` that `collectFileMatches` discards. Either use it to order file evidence or delete it.
- `searchSessions` accepts `options?: { defaultLimit? }` and ignores it; the picker passes `{ defaultLimit: undefined }`. Delete the parameter.

## Edge Cases & Failure Modes

- **Unclosed quote or parenthesis:** Reject the query with a clear validation error before reaching SQLite.
- **Raw FTS syntax injection attempt:** Reject through parsing or quote the content as a literal term. Never pass raw remainder text to `MATCH`.
- **Negative-only query:** Reject in Phase 1 with guidance to add a positive search term.
- **Negation under OR or nested parens:** Reject forms such as `foo OR -bar` in Phase 1; session-level exclusion cannot represent them.
- **Quoted single word:** Treat `"sqlite"` as exact, not prefix.
- **Unquoted symbol-heavy term:** Quote it for FTS5. Under unicode61 the tokenizer then splits the quoted string into an ordered *phrase* (`"extensions/session-search.ts"` → phrase `extensions session search ts`), which is exactly the adjacency-preserving behavior paths need — without promising literal punctuation-sensitive substring search.
- **Invalid time filter value:** Fail closed with a validation error in the shared layer. Today `normalizeTimeFilter` silently drops unparseable dates, which widens the search; the tool wrapper validates but the picker path does not.
- **No-query file search:** Return matching sessions chronologically, newest first by default.
- **Very broad query:** Use SQL overfetch and bounded per-session evidence/contribution to avoid one long session dominating payloads.
- **Schema mismatch:** Continue to fail closed and direct the user to rebuild the session index.

## Alternatives

### Use `liqe` or another Lucene-like parser

- **Status:** Rejected
- **Decision or open issue:** These libraries parse broad Lucene-like languages rather than SQLite FTS5. They reject useful tokens, support syntax we would not expose, and still require a custom compiler/safety adapter.
- **Retained discussion:** `liqe` was the best candidate from the spike, but adopting it would not remove the hard part: safe SQLite-specific compilation.

### Use Gmail-style field extraction in Phase 1

- **Status:** Rejected
- **Decision or open issue:** The agent-facing tool already has structured fields. Adding query-string fields now would expand parser scope without solving the core ranking bug.
- **Retained discussion:** Field syntax may be useful later for the interactive session reference picker or a human-facing search box.

### Support negative-only searches immediately

- **Status:** Deferred
- **Decision or open issue:** Negative-only search requires anti-match browse/filter semantics rather than ordinary ranked FTS retrieval.
- **Retained discussion:** It is useful and should be revisited after the main positive-query ranking path is corrected.
- **Next step:** Design a browse anti-match execution path that excludes sessions matching negative text.

### Add separate code-aware/prose-aware FTS indexes

- **Status:** Deferred
- **Decision or open issue:** Code-aware search could improve path and symbol recall, but Phase 1 can get substantial benefit from safer query compilation and better ranking with one index.
- **Retained discussion:** If single-index search still disappoints after Phase 1, revisit generated code tokens or separate FTS tables. A trigram tokenizer (true substring search at ~3× index size) belongs in that same conversation.
- **Next step:** Evaluate after the revised single-index implementation is tested against real queries.

### Index edit/write payload contents in Phase 1

- **Status:** Deferred
- **Decision or open issue:** Indexing `oldText`, `newText`, and `content` would improve code-change search but adds storage and chunking decisions.
- **Retained discussion:** This is likely Phase 2 because the index is local and rebuildable, but it is not required to fix the current ranking and filtering problems.
- **Next step:** Design chunking/storage rules for edit/write payloads after Phase 1 lands.

## Implementation Plan

- [ ] Phase 1: Query language module
  - Goal: The boolean query grammar exists as a standalone, fully tested unit — lexer, parser, and compiler emitting `{match, excludes}` — with nothing wired to it yet.
  - Files: `extensions/shared/session-index/query/lexer.ts`, `parser.ts`, `compiler.ts`; `test/session-search.query.test.ts`
  - Work: Implement the grammar in Exposed Shape: term lexing (including the hyphen-at-term-boundary rule and the unquoted-term character set), operators, precedence, embedded phrases, trailing `*`. Compile per Decision 1 with every term emitted quoted. Reject negative-only queries, negation outside the top-level conjunction, and unclosed quotes/parens with clear validation errors. Golden tests map inputs to compiled output or rejection.
  - Validation: `npm run check`; golden tests cover every rule and query-related edge case in this doc.

- [ ] Phase 2: Schema break and indexing
  - Goal: The index schema and writers match Decision 9; existing search behavior is unchanged against a rebuilt index.
  - Files: `extensions/shared/session-index/schema.ts`, `store.ts`, `common.ts` (`INDEX_SCHEMA_VERSION`); `test/session-search.db.test.ts`, `test/session-search.reindex.test.ts`
  - Work: Bump `INDEX_SCHEMA_VERSION`. Add `session_repo_roots(session_id, repo_root, repo_basename)` populated on session insert/upsert (keep `repo_roots_json` for result shaping). Set the FTS tokenizer explicitly. Stop writing `session_id` chunks (`insertSessionIdChunk`/`syncSessionIdChunk`).
  - Validation: `npm run check`; rebuild the local index via `/session-index` and confirm `session_search` and the picker still return sane results.

- [ ] Phase 3: SQL-first execution and ranking
  - Goal: `searchSessions` runs compiled queries with SQL-side filters, bounded result sets, and the new scoring. Result shape stays the current single-snippet form — but the snippet is now the top-ranked chunk.
  - Files: `extensions/shared/session-index/search.ts`, new `extensions/shared/session-index/scoring.ts`, `common.ts` (retire `buildFtsQuery`/`sanitizeFtsToken` and friends), `extensions/session-search/normalize.ts` (drop the `"touched"` op), `extensions/session-handoff/query.ts` (drop `defaultLimit`); `test/session-search.tool.test.ts` and new ranking tests
  - Work: Wire compiler output into `MATCH` plus session-level exclusion subqueries (Decision 4). Move repo filtering to `session_repo_roots`, session exclusion to `NOT IN`, file filtering to an indexed `basename`/`op` prefilter with JS path refinement. Add `ORDER BY bm25 LIMIT` overfetch and select chunk-level columns only. Implement `scoring.ts`: rank-position normalization, top-K bounded text contribution, age-based recency decay, and the exact-session-id invariant. Fail closed on invalid time filters in the shared layer. Delete the dead `FilePathMatch.score` or put it to use (Decision 12).
  - Validation: `npm run check`; committed ranking-invariant tests (exact session-id beats any text accumulation, phrase match beats scattered tokens, newer beats older at equal text score); smoke queries against the real rebuilt index.

- [ ] Phase 4: Evidence results and exposed surfaces
  - Goal: Results carry bounded evidence arrays, and the tool and picker surfaces match Exposed Shape.
  - Files: `extensions/shared/session-index/search.ts`, `common.ts` (result type); `extensions/session-search.ts`; `extensions/session-handoff/query.ts`, `picker.ts`; corresponding tests
  - Work: Introduce the `SessionSearchEvidence` union with the 20-snippet bound and fold `matchedFiles` into `file_touch` evidence. Update renderers to preview the top three snippets. Add `sort` and `files.changed` tool parameters, fix the time-parameter descriptions, and rewrite `promptGuidelines` to document the grammar. Demote picker lineage priority to a tiebreak below relevance in search mode.
  - Validation: `npm run check`; live smoke test in a pi session exercising the tool and the picker, showing multi-snippet evidence and grammar queries end to end.

- [ ] Phase 5: Qualitative tuning
  - Goal: Scoring constants are tuned against the real local index; no new committed tooling.
  - Files: `extensions/shared/session-index/scoring.ts` (constants only)
  - Work: Run the disposable side-by-side harness per Decision 11 comparing main against the revised implementation on real recall queries. Adjust half-life, top-K, source weights, and overfetch size.
  - Validation: Side-by-side results reviewed; ranking-invariant tests still pass unchanged.
