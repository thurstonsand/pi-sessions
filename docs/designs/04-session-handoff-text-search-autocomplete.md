# 04 — Session handoff autocomplete text search

## Context

`@session` autocomplete should support two distinct workflows:

1. **Browse** all sessions
2. **Search** sessions by remembered text or pasted UUID

The inserted token remains canonical:

- `@session:<uuid>`

That keeps the model/runtime contract unchanged while making discovery much easier.

The implementation should fit the current package structure:

- `extensions/session-handoff/autocomplete.ts`
  - prompt parsing
  - provider behavior
  - completion application
- `extensions/session-handoff/query.ts`
  - autocomplete candidate shaping
- `extensions/session-search/db.ts`
  - shared SQLite query layer
  - shared search and ranking behavior
- `extensions/session-handoff.ts`
  - editor installation glue
- `extensions/session-handoff/powerline.ts`
  - Powerline bridge

## Goals

- keep `@session:<uuid>` as the inserted completion token
- treat `@session:` and `@session ` the same
- support browse mode and search mode
- make session-id matches rank above everything else when they match
- share one DB-backed search/ranking implementation between autocomplete and `session_search`
- treat cwd / repo / file constraints as **filters**, not rank boosts
- keep `Alt+A` as a filter toggle that reruns the query
- allow browse mode to show the full session list
- prefer a simple first implementation over a richer query language

## Non-goals

- preserving backward compatibility with older index shapes or query behavior
- keeping a UUID-only parser mode
- routing autocomplete through the `session_search` tool surface
- introducing advanced filter syntax in v1

## UX contract

## Browse mode

These all open browse mode:

- `@session`
- `@session:`
- `@session `
- `@session    `
- `@session:   `

Behavior:

- show every indexed session
- keep the list scrollable
- apply the active filter set
- `Alt+A` toggles the cwd filter and reruns browse

## Search mode

These all open search mode:

- `@session autocomplete`
- `@session:autocomplete`
- `@session: autocomplete`
- `@session   autocomplete`
- `@session: 2dc89501-5e75-4c75-bc71-15c499d850b2`

Behavior:

- normalize colon and space the same way
- trim the search text after the optional separator
- search within the currently filtered session set
- selecting a result still inserts `@session:<uuid>`

## Filter model

A filter is not the same thing as a search.

The order of operations should be:

1. build the candidate session set from filters
2. run lexical / metadata search within that filtered set
3. rank the matching sessions

Examples of filters:

- current working directory
- current repo root
- touched file
- time window

Examples of searches:

- `autocomplete`
- `sqlite ranking`
- pasted UUID text

This distinction matters because filters constrain the universe first. Ranking happens after that.

## `Alt+A`

`Alt+A` should toggle the active cwd filter.

Concretely:

- default mode: filter to the current cwd and anything under it, matching `session_search` semantics
- widened mode: remove the cwd filter
- after toggling, rerun the browse or search query

If later we want a broader default filter model such as repo-first with cwd fallback, that is still a filter-layer concern. `Alt+A` remains a filter toggle, not a mode toggle.

## Parser design

`extensions/session-handoff/autocomplete.ts` should expose a parser that distinguishes only:

- `browse`
- `search`

Suggested shape:

```ts
export interface HandoffAutocompleteMatch {
  raw: string;
  start: number;
  end: number;
  mode: "browse" | "search";
  query?: string;
}
```

Parsing rules:

1. detect a terminal `@session` token near the cursor using the current boundary rules
2. inspect the tail after `@session`
3. if the tail is empty, or only `:` plus whitespace, use `browse`
4. otherwise:
   - remove one optional leading `:`
   - trim whitespace
   - if the remainder is empty, use `browse`
   - otherwise use `search`

Examples:

- `@session` → `browse`
- `@session:` → `browse`
- `@session   ` → `browse`
- `@session:   ` → `browse`
- `@session foo` → `search("foo")`
- `@session:foo` → `search("foo")`
- `@session:  foo` → `search("foo")`

This parser should remain the single source of truth for:

- whether session autocomplete is active
- what span gets replaced on completion
- whether browse or search should run

## Query architecture

## 1. Shared DB layer

Autocomplete and `session_search` should use the same DB-backed search implementation in `extensions/session-search/db.ts`.

That shared layer should own:

- filter application
- lexical query normalization
- FTS query construction
- session-id matching
- metadata matching
- collapse of many hit rows into one ranked result per session
- ranking
- snippet selection

`extensions/session-handoff/query.ts` should stay thin and focused on autocomplete presentation.

## 2. Browse and search are separate query paths

The query layer should expose two distinct behaviors:

- `browse`
  - return all filtered sessions in browse order
- `search`
  - return matching sessions from the filtered set in ranked order

Suggested autocomplete query options:

```ts
interface ListHandoffAutocompleteCandidatesOptions {
  currentSessionPath?: string;
  currentCwd?: string;
  includeAll: boolean;
  indexPath: string;
  mode: "browse" | "search";
  query?: string;
}
```

`includeAll` here means the cwd filter is removed.

## 3. Filters come first

The shared DB search layer should accept explicit filters.

Suggested shape:

```ts
interface SessionSearchFilters {
  cwd?: string;
  repo?: string;
  touched?: string[];
  after?: string;
  before?: string;
}
```

For autocomplete v1:

- browse and search should primarily use the cwd filter
- later phases can add file and other filter syntax on top of the same layer

The important architectural rule is:

- filters constrain rows first
- search scores only the remaining rows

## Ranking design

## 4. Session ID match is top priority

If the query matches a session UUID strongly, that session should rank first.

This should outrank every other evidence source.

A pasted full UUID should effectively resolve to the matching session at the top of the list.

A strong prefix or exact lexical hit on `session_id` should beat title-only or transcript-only matches.

## 5. Keep the first ranking model simple

For the first pass, rank by a small set of high-signal sources:

1. `session_id`
2. recency
3. `session_name`
4. `handoff_next_task`
5. `handoff_goal`
6. then finally, transcript / indexed chunk matches

KISS is the right default here.

## 6. Ranking happens after filtering

Once filters have narrowed the candidate set, search ranking should order matches by signal strength.

Recommended priority:

1. `session_id`
2. recency as a strong score component, not just a final tie-break
3. `session_name`
4. `handoff_next_task`
5. `handoff_goal`
6. transcript matches

In practice, for non-UUID searches, recently touched sessions should usually surface ahead of older similarly relevant sessions.

The final score should be a weighted combination of:

- lexical relevance from FTS
- source weights by matched field
- recency
- independent-hit bonus across distinct evidence sources

This can use SQLite FTS relevance as the lexical base score, but the product ranking should not be BM25 alone.

Lineage, cwd, and repo should not be thought of primarily as boosts here.

They are part of filtering.

If some context is absent at runtime, the corresponding filter simply is not applied.

## Search implementation notes

Current code already provides useful building blocks:

- indexed session metadata in `sessions`
- indexed transcript and metadata chunks in `session_text_chunks`
- FTS in `session_text_chunks_fts`
- query construction in `buildFtsQuery(...)`

The shared search layer should use one FTS-backed search base for everything searchable, including:

- `session_id`
- `session_name`
- `handoff_next_task`
- `handoff_goal`
- transcript / indexed chunk text

The preferred design is to put all searchable text into that one search corpus rather than unioning across separate query strategies.

That keeps the search path conceptually simple:

- apply filters
- run one FTS query
- collapse hits to one ranked result per session

For `session_id`, the index should store both:

- the canonical UUID form with hyphens
- a compact UUID form with the hyphens removed

That allows normal searching to match:

- full UUIDs with dashes
- UUIDs without dashes
- UUID prefixes
- mixed text queries that happen to include UUID fragments

This should not rely on detecting a special UUID-only query mode. UUID matches are simply a high-weight evidence source within the normal search path.

Canonical and compact session-id hits for the same session should be deduplicated so they contribute one `session_id` evidence signal, not two.

`session_id` should still be treated as the strongest signal inside ranking even though it lives in the same search base.

Backward compatibility is not a concern here. If schema changes make the index simpler or better, we can require reindexing.

## Rendering behavior

Autocomplete rendering should stay stable across modes.

In Pi terms:

- `label` is the primary visible identity of the suggestion row
- `description` is the secondary supporting text shown alongside it

For session autocomplete:

- label: short stable session label
- description:
  1. best snippet for search results
  2. otherwise handoff metadata
  3. otherwise title

Selecting any result should always replace the typed span with:

- `@session:<uuid>`

If the index is missing or incompatible, autocomplete should show a special error result instead of normal suggestions.

That error result should:

- work in both standalone and Powerline modes
- clearly explain the index problem
- tell the user to run `/session-index` and press `r` to rebuild
- be a no-op if selected

This is preferable to relying on editor-local widget behavior that may not be consistently available through the Powerline integration path.

## Browse output size

Browse mode should show the full filtered session list.

There is no product need to artificially trim browse results to a tiny number if the UI can scroll.

The same reasoning applies to search results for the first pass.

So the initial implementation should avoid query-length limits, result-count limits, or performance-oriented guardrails unless they are required for correctness.

Start with the naive full-result approach and then tune only after real usage shows where it breaks.

## Implementation plan

### 1. Replace the parser in `extensions/session-handoff/autocomplete.ts`

- replace `detectHandoffPrefix(...)`
- add a `browse | search` parser
- normalize colon and space the same way
- preserve replacement-span tracking
- export the parser for direct tests

### 2. Update `HandoffAutocompleteProvider`

- branch on `browse` vs `search`
- keep completion insertion unchanged
- keep wrapped-provider passthrough behavior unchanged
- keep `Alt+A` as a cwd-filter toggle

### 3. Refactor `extensions/session-handoff/query.ts`

- make the API mode-aware
- keep it thin
- for browse: map filtered sessions to candidates
- for search: map shared ranked search results to candidates

### 4. Refactor `extensions/session-search/db.ts`

- add an explicit filter-first query path shared by autocomplete and `session_search`
- treat `session_id` as the highest-signal search field
- index both canonical and compact session-id forms into the shared search corpus
- collapse multiple hit rows for the same session into one ranked session result
- deduplicate canonical and compact session-id matches into one evidence signal
- keep the first ranking model simple
- reuse existing FTS helpers where possible
- allow schema/query changes freely and rely on reindexing when needed

### 5. Update `extensions/session-search.ts`

- keep the public tool contract stable enough for intended usage
- route it through the shared filter-first search implementation

### 6. Add tests

At minimum:

- parser tests for colon / space equivalence
- tests that separator-only input stays in browse mode
- tests that `@session foo` and `@session:foo` produce the same search query
- tests that a UUID match ranks first
- tests that canonical and compact session-id matches are deduplicated
- tests that recency strongly affects non-UUID ranking
- tests that search still inserts canonical `@session:<uuid>`
- tests that `Alt+A` removes and restores the cwd filter
- DB tests covering filter-first behavior
- parity tests showing autocomplete search and `session_search` use the same ranking rules
- tests for the index-error autocomplete row and no-op selection behavior

### 7. Add a smoke test phase

Use the interactive shell tool to launch Pi against this package and exercise the real editor flow.

The smoke test should:

- open Pi with the extension loaded
- focus the prompt editor
- type `@session`
- confirm browse results populate
- try several search forms such as `@session autocomplete`, `@session:autocomplete`, and a pasted UUID
- toggle `Alt+A` and confirm the cwd filter is removed and restored
- verify that selecting a result inserts canonical `@session:<uuid>`
- verify that missing-index failures are loud and explicitly suggest reindexing

### 8. Update docs

Document:

- `@session` opens browse
- `@session foo` and `@session:foo` search the same way
- `Alt+A` widens by removing the cwd filter
- selected suggestions still insert `@session:<uuid>`

## Edge cases

### Missing or incompatible index

- autocomplete should fail loudly with user-visible feedback
- instead of normal suggestions, it should show a special error result row
- the message should explicitly say the index is missing or incompatible and that the user likely wants to reindex
- `session_search` should continue to direct the user to rebuild
- schema changes are acceptable; reindex is the supported path

### Empty search text

If the text after `@session` becomes empty after removing an optional colon and trimming, remain in browse mode.

### Full UUID paste

A pasted UUID should surface the exact session as the first result.

This should work whether the query text uses:

- canonical UUID form with dashes
- compact UUID form without dashes
- UUID prefixes

### Future file-filter syntax

A future syntax such as:

- `@session file:model.ts autocomplete`

should build on the same filter-first shared query layer.

## Summary

The design is:

- `@session`, `@session:`, and separator-only variants open browse
- `@session <text>` and `@session:<text>` run the same search
- filters narrow the candidate set before search runs
- `Alt+A` toggles the cwd filter and reruns the query
- `session_id` is the highest-priority search signal
- autocomplete and `session_search` share one DB-backed search/ranking implementation
- completion insertion remains canonical: `@session:<uuid>`
