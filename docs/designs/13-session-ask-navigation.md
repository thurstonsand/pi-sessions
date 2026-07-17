# Session Ask as a Navigating Sub-Agent

## Status

Accepted

## Decision Summary

> **Later refinement:** [Design 16](16-pi-0806-session-transcript-modernization.md) specifies coordinated pre-start and in-flight cancellation, including awaited nested abort, retry suppression, and exactly-once disposal. The navigation model remains unchanged.

`session_ask` answers questions by launching a focused Pi sub-agent that navigates one target session through a compact **Conversation Span** map, scoped session search, and bounded session reads. It does not render the whole session tree or a full entry index into the prompt.

The tradeoff is intentional: more adaptive tool use and slightly more latency in exchange for scaling to large, branched, compacted sessions and for better evidence checking. The sub-agent can search for leads, inspect exact entries, follow branches, verify later revisions, and optionally compare the session history against the current workspace.

## Problem Statement / Background

The previous `session_ask` model rendered an entire session tree into one prompt. That failed as sessions accumulated long histories, rewinds, abandoned branches, compactions, and large tool outputs.

Compaction protects Pi's active working context; it does not shrink the raw session file. The old entries remain on disk. Loading all of them at once makes important facts easy to bury and can exceed context on sizeable sessions.

The durable shape of a session is not a flat transcript. It is a tree. The useful orientation primitive is therefore not a giant entry table, but a compact map of navigable ranges.

## Goals

- Answer questions about large sessions without loading the whole session into the prompt.
- Preserve branch and rewind semantics.
- Let the sub-agent search, read, and verify original evidence.
- Make broad reads cheap and targeted reads exact.
- Keep the outer `session_ask({ session, question })` interface unchanged.
- Allow current-repo cross-checks without confusing repo state with session history.

## Non-Goals

- Exposing `entryId`, span, or branch mechanics to the outer caller.
- Building a deterministic retrieve-then-answer pipeline.
- Cross-session navigation. The sub-agent works inside one target session.
- Treating compaction summaries as primary evidence.

## Outer Tool Contract

The caller invokes:

```ts
session_ask({ session: string, question: string })
```

The extension resolves the target session using the session index, then starts the navigation sub-agent. The returned answer remains markdown text, with optional relevant-file metadata in tool details.

If the caller aborts, `session_ask` reports cancellation. It does not fabricate an evidentiary failure.

## Sub-Agent Prompt Shape

The sub-agent receives:

- target session metadata: id, title, cwd, timestamps, entry/message/span counts
- a `## Session Map` containing **Conversation Spans**
- target project `AGENTS.md`, or `<file not found>`
- the caller's question

It does **not** receive a full entry index.

The navigation system prompt identifies the agent as an evidence-first session analyst and requires it to:

- verify original evidence before answering
- check newer messages for revisions or contradictions
- treat tool calls as attempts and tool results as outcomes
- distinguish “the session says” from “the current repo says”
- treat compaction summaries as navigation aids
- call `provide_results` exactly once

## Conversation Spans

A Conversation Span is a contiguous section of a root-to-leaf conversation path bounded by structural events such as branch starts, branch summaries, compactions, or leaves.

Spans render as:

```md
#### Span (startEntryId, endEntryId) (on_active_branch)
- branches_to: nextStart | otherNextStart
- entries: 42
- last_activity: 2026-07-04T12:34:56.000Z
- first_user_message:
  ````md
  ...
  ````
- branch_summary:
  entry: abc123
  timestamp: ...
  content:
    ````md
    ...
    ````
```

The start id is a read anchor. The end id is the `pathTarget` for reading that span. `branches_to` lists the next span starts; multiple values indicate a fork. `on_active_branch` marks membership in the current live path, while shared trunk spans may both be active and branch to abandoned spans.

This is `O(spans)`, not `O(entries)`. Precise entry ids are discovered through `session_search` and followed with `session_read`.

## Internal Tools

### `session_search({ query, limit? })`

Searches the target session through the session index and returns entry-level hits. Model-facing output is formatted for navigation:

```md
### entryId
source_kind: assistant_text
timestamp: ...
size: 1234
branches: leafId*
span: (spanStart, spanEnd) on_active_branch; before 7; after 2
snippet:
````
...
````
```

Rank is kept in structured details, not shown to the model. Hits include branch membership and containing-span context so the sub-agent can choose safe `before`/`after` windows.

If the index cannot be opened, `session_search` returns an explicit search-unavailable message and tells the agent to navigate via the span map and `session_read`. Missing search is never reported as “no matches.”

### `session_read({ entryId, pathTarget?, before?, after?, body? })`

Reads entries from the target session file using Pi session parsing.

Modes:

- `pathTarget`: read from `entryId` through `pathTarget` along that path.
- `before` / `after`: read local context around `entryId`. Without an explicit `pathTarget`, the tool infers the containing span path target, including abandoned branches. Local context reads must stay inside that span.

`pathTarget` and `before`/`after` are mutually exclusive. If a read needs to cross spans, use `pathTarget`.

`body` controls rendering:

- `preview` (default): preserves conversational user/assistant text, elides thinking as `thinking…`, summarizes tool calls, and trims tool results to small previews with size metadata.
- `full`: targeted evidence mode. It renders full stored entry content up to the hard safety caps and composes with both `pathTarget` and `before`/`after`.

Large reads paginate near Pi `read`'s 50KB model-facing cap. Pagination happens at entry boundaries and returns `nextEntryId` when more requested entries remain.

`truncated: true` means the entry body itself hit the hard entry cap. Preview elision is not treated as truncation.

### `provide_results({ answer, relevantFiles? })`

Terminates the sub-agent turn. `answer` is markdown. `relevantFiles`, when present, uses absolute paths and describes why each file matters.

The runner retries up to three times if the sub-agent stops without calling `provide_results`.

### Workspace tools

The sub-agent also receives Pi's `read`, `grep`, `find`, and `ls` tools rooted at the target session's recorded `cwd`. These tools are for checking current repo state. Answers must keep session history separate from current filesystem facts.

## Navigation Data Model

`loadSessionNavigationData` opens the session through `SessionManager.open` and derives a reusable navigation model once:

- `entryById`
- `childrenByParent`
- leaf branches and branch labels
- `branchPaths`
- `entryBranchesById`
- conversation spans
- `spanByEntryId`
- rendered entry sizes

Consumers use these maps rather than recomputing paths per search hit or read. Search-hit formatting, span lookup, branch lookup, implicit path-target resolution, and span-boundary checks are map lookups over the loaded model.

## Renderer Policy

The session indexer and the session reader have different rendering goals.

The indexer extracts compact searchable chunks. The session reader renders evidence for an agent.

`session_read` therefore uses its own renderer instead of Pi's summarization serializer. Pi's serializer truncates tool results internally for summaries, which would make `body=full` misleading. The reader preserves typed session messages directly and applies its own preview/full policy.

## Persisted Debug Runs

`sessions.ask.persistRuns` can persist sub-agent runs under:

```text
~/.pi/agent/pi-sessions/session-ask/
```

This is off by default. When enabled, `session_ask` returns the debug session path in tool details and answer text, making real prompt/tool traces reviewable.

## Edge Cases

- **Linear session:** one branch, one active path; reads work without branch decisions.
- **Abandoned branch hits:** search hits include branch/span data; local context reads infer the containing span path target.
- **Shared trunk before a fork:** default path selection chooses a containing branch, active-preferred. It never chooses a leaf that does not contain the anchor.
- **Span-boundary crossing:** local `before`/`after` reads error with a path-target hint. Explicit `pathTarget` is required to read across spans.
- **Missing index:** search is unavailable, not “no matches”; direct session reads still work once the target session has been resolved.
- **Oversized reads:** output paginates near 50KB with `nextEntryId`.
- **Oversized single entry:** the entry is capped and marked `truncated: true`.
- **Abort:** caller cancellation aborts the sub-agent and reports cancellation.

## Deleted Prior Renderer

The old one-shot renderer in `extensions/session-search/extract.ts` was removed. The indexer remains responsible for session records, text chunks, file touches, handoff metadata, and tail extraction. It no longer carries a second session-rendering engine.

## Alternatives Considered

### Whole-session render

Rejected. It does not scale and obscures evidence.

### Full entry index in the prompt

Rejected after implementation review. It is smaller than the whole transcript but still grows with entries, not structure. Conversation Spans are a better orientation layer.

### Deterministic retrieve-then-answer

Rejected. It is cheaper but less capable of adaptive digging, branch-sensitive verification, and later-revision checks.

### Branch-list tool

Rejected. The map is cheap and always needed, so seeding it avoids a predictable first tool call.

### Free-text final answer

Rejected. A terminating `provide_results` tool makes answer capture deterministic.

## Validation

Primary validation is `npm run check`, plus smoke tests against real sizeable sessions with `sessions.ask.persistRuns` enabled. Trace review checks:

- prompt includes Conversation Spans and no full entry index
- search hits include span/branch hints
- broad reads default to preview and remain compact
- targeted full reads return exact evidence
- pagination returns continuation ids
- abandoned-branch reads infer the correct path target
- aborts report cancellation
