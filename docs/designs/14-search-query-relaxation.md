# Search Query Relaxation

## Status

Approved

## Decision Summary

Make plain multi-term search queries forgiving without weakening explicit syntax: chunks matching every term rank first, and partial matches backfill the remaining result budget via a second relaxed FTS pass. Quoted terms, explicit operators, and negation always keep their strict meaning. The tradeoff: at most one extra bounded FTS query per search, in exchange for eliminating the zero-result dead ends that cost the ask sub-agent tool round trips.

## Problem Statement / Background

The query compiler (design doc 11) treats adjacent terms as strict `AND`, and chunks are small — tool results clamp at 500 characters at index time — so a plain multi-term query requires every term to appear in the same ~500-character passage. That is the strictest configuration in the lexical-search design space: passage-level exhaustive AND.

The `session_ask` navigation smoke test (design doc 13) exposed the consequence. Asked about a known fact — a DB/access/search cleanup commit — the sub-agent's first several `search_session` calls returned zero hits because it mixed target terms with framing words from the test setup ("persistence", "smoke", "tool-call indexing"). One absent term voids the whole query. The agent recovered by falling back to the seeded entry map and `session_read`, so the answer was correct, but several tool round trips were spent rediscovering that its queries were over-specified. Humans calling `session_search` over-specify the same way.

This is a well-known class of problem with established industry answers: Lucene/Elasticsearch default to OR-with-ranked-coverage; Elasticsearch offers `minimum_should_match`; Algolia (`removeWordsIfNoResults`), Meilisearch (default term dropping), and Typesense (`drop_tokens_threshold`) all relax queries rather than return nothing. This design adapts that pattern to FTS5 and to an LLM caller.

## Goals

- A plain multi-term query never returns fewer results because the caller added a related-but-absent term; extra terms improve ranking instead of risking zero hits.
- Full matches always outrank partial matches.
- Explicit syntax stays a contract: quotes, `AND`, `OR`, `NOT`/`-term`, and parentheses mean exactly what design doc 11 says they mean.
- No additional tool round trips: relaxation happens inside a single search call.
- One behavior across `session_search`, the session reference picker, and the ask sub-agent's `search_session`.

## Non-Goals

- Semantic or hybrid retrieval (embeddings, vector search, synonym expansion). The observed failure is term over-specification, not vocabulary mismatch, and an embedding dependency is disproportionate for a local rebuildable index.
- `minimum_should_match`-style k-of-n matching. FTS5 has no native support; emulation is combinatorial.
- Changing strict compilation, the grammar, or the index schema. No reindex is required.
- Surfacing relaxation in rendered results. It is a ranking behavior, not a result annotation.

## Exposed Shape

No new parameters and no result-shape change. What changes is the meaning of a plain term list, documented in the tool descriptions:

- `session_search` `query` description and the ask sub-agent's `search_session` description gain the contract line: plain adjacent terms rank full matches first and backfill with partial matches; use quotes or explicit `AND` to require a term.

The grammar from design doc 11 is unchanged. One concept is added on top of it:

- **Adjacency run**: a maximal sequence of consecutive unquoted terms. Quoted terms, explicit operators, negations, and parentheses terminate a run. The run is the only unit relaxation may loosen; a run of one term has nothing to relax.

Worked examples:

| Query | Strict (unchanged) | Relaxed pass |
| --- | --- | --- |
| `bar baz fud` | `bar AND baz AND fud` | `bar OR baz OR fud` |
| `foo AND bar baz fud` | `foo AND bar AND baz AND fud` | `foo AND (bar OR baz OR fud)` |
| `foo AND bar baz -fud` | same, excluding sessions matching `fud` | `foo AND (bar OR baz)`, same exclusion |
| `foo AND bar -baz fud` | two single-term runs | not relaxable — strict only |
| `"session search" ranking cleanup` | phrase AND `ranking` AND `cleanup` | phrase AND (`ranking` OR `cleanup`) |
| `(a b) OR c` | `(a AND b) OR c` | `(a OR b) OR c` |

## Design Decisions

### 1. Backfill, not zero-hit fallback

Relaxation is not error recovery; it is tiered ranking. The strict query runs first and its rows always lead. If strict rows fill the requested limit, the relaxed pass is skipped. Otherwise the relaxed query runs once with the same filters and limit, and its rows — deduplicated against the strict rows by chunk id — fill the remaining budget.

A zero-hit-only trigger was considered and rejected: it creates a cliff where two strict hits suppress fifty good partial matches, and the caller pays a tool round trip to discover that. Backfill gives the same worst case (two bounded FTS queries) with no cliff. Within the backfill tier, bm25 on the relaxed query orders by term coverage and IDF — a chunk matching six of nine terms outranks one matching two, and corpus-common framing words contribute little.

In the cross-session `searchSessions` path the chunk query overfetches (`max(200, limit × 25)`), so the relaxed pass will run on most searches there. That is one extra bounded FTS query, accepted. Strict rows are concatenated before relaxed rows, so the existing rank-position scoring (`scoreTextHit` over row index) discounts backfill contributions with no scoring changes.

### 2. The adjacency run is the only relaxable unit

Explicit syntax is a contract. Anything the caller wrote deliberately — quoted terms and phrases, `AND`, `OR`, negation — is never loosened; only bare adjacent terms relax. A run is a *maximal sequence of consecutive unquoted terms*: any non-plain token terminates it. This single rule yields the intuitive readings verified during design (see worked examples), including that a negation splits its neighbors into separate runs and that `foo AND bar -baz fud` is not relaxable at all.

Consequences worth noting:

- Quoting a term is now also the way to pin it: `"commit" hash cleanup` requires `commit` exactly while `hash` and `cleanup` relax.
- Parentheses group but do not pin; adjacency inside parens still relaxes.
- Precedence gains one level — adjacency binds tighter than explicit `AND` — but because `AND` is associative, strict compilation output is byte-for-byte unchanged. Only the relaxed compilation reads the run structure.

Mechanically: the parser collects consecutive unquoted terms into a group node; the compiler emits the strict `match` exactly as today and additionally a `relaxedMatch` in which each group of two or more terms compiles to `OR` instead of `AND`. `relaxedMatch` is absent when it would equal the strict match, which is the signal to skip the second pass. Top-level excludes are shared by both passes unchanged.

### 3. Relaxation is invisible to callers

No "partial match" labels in results or rendering. The information already exists where it matters: ordering carries the tiering, and FTS snippet highlight markers show exactly which terms matched each chunk, so the ask sub-agent can judge coverage per hit before spending a `session_read`. A true zero-hit response now means no term appears anywhere in scope — "no matches" is complete information, so no instructive error text is added.

The accepted risk is noise: a stray term now always matches something. Recovery is natural — the caller narrows with structured filters (`repo`, `cwd`, `time`, files) or pins terms with quotes. Observe before adding machinery.

### 4. One implementation in the shared retrieval layer

The backfill lives in `getTextMatchRows`, beneath both `searchSessions` (tool + picker) and `searchSessionChunks` (ask sub-agent). Both surfaces get identical semantics for free, preserving the "consistent with `session_search`" property. No schema change, no reindex, no scoring-constant changes.

## Edge Cases & Failure Modes

- **All-explicit query (`a AND b`, `"exact phrase"`):** no run of ≥2 terms, `relaxedMatch` absent, single strict pass — identical to today.
- **Single-term query:** nothing to relax; unchanged.
- **Strict pass fills the limit:** relaxed pass skipped; cost identical to today.
- **Relaxed pass still empty:** genuine no-match; existing empty-result behavior stands.
- **Duplicate rows across passes:** relaxed matches are a superset of strict matches; dedupe by chunk id keeps strict placement.
- **Negation:** exclusion subqueries apply to both passes; a relaxed hit in an excluded session never appears.
- **Session-scoped search vs corpus-global IDF:** bm25 statistics span the whole index while `search_session` filters to one session, so a corpus-rare but session-irrelevant term can float a weak chunk within the backfill tier. Coverage summing usually dominates; accepted, observe.
- **Model keeps issuing timid queries:** the learned habit of minimizing terms to avoid zero results is counterproductive under the new contract; the tool description line in Exposed Shape exists to retrain it.

## Alternatives

### OR-by-default (Lucene/Elasticsearch default operator)

- **Status:** Rejected
- **Decision or open issue:** Simplest mental model and best recall, but it deletes the strict-AND guarantee of design doc 11 everywhere — every plain query matches noise, and there is no way to express "all of these" without writing explicit `AND` chains.
- **Retained discussion:** Backfill delivers the same recall with full matches guaranteed on top, which strictly dominates.

### Zero-hit-only fallback (Algolia/Meilisearch trigger)

- **Status:** Rejected
- **Decision or open issue:** Creates a results cliff at one strict hit and burns a tool round trip when the caller wants more than the strict matches. Backfill has the same query cost without the cliff.

### Progressive term dropping (Meilisearch mechanism)

- **Status:** Rejected
- **Decision or open issue:** Drops terms last-first, assuming query word order encodes importance. True for humans typing, false for LLM-generated keyword bags. OR-with-bm25 lets absent terms contribute nothing without guessing which term to drop.

### `minimum_should_match` (Elasticsearch)

- **Status:** Rejected
- **Decision or open issue:** Best precision/recall balance on paper, but FTS5 has no native support; emulation requires combinatorial query expansion or matched-term post-counting. Complexity disproportionate to the observed failure.

### Semantic / hybrid retrieval (embeddings + BM25)

- **Status:** Rejected
- **Decision or open issue:** Out of scope. Solves vocabulary mismatch, which is not the observed failure, at the cost of an embedding model and vector storage in a local rebuildable SQLite index.
- **Retained discussion:** If lexical relaxation still disappoints on recall — the "auth" vs "login" case — this is the next tier to evaluate, alongside the deferred trigram/code-token ideas from design doc 11.

### Prompt-and-feedback only

- **Status:** Rejected
- **Decision or open issue:** Teaching the sub-agent to issue fewer, more precise terms relies on the model performing relaxation itself across turns — exactly the round trips observed in the smoke-test trace.
