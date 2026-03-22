# Session Search Capability Plan

## Context

Pi currently has `session_query`, which is useful once you already know which session to inspect. It does not solve discovery across prior work.

We want a new `session_search` capability that can answer questions like:

- Which past sessions changed a given file?
- Which sessions discussed a topic or error message?
- Which sessions in a repo or folder from the last week touched Pi configuration?
- Which prior sessions are likely relevant to the current task?

This is a discovery tool, not a synthesis tool. `session_search` should return candidate sessions. V1 should also include a built-in `session_ask` tool as the follow-up analysis surface, replacing the existing `session_query` workflow for this package.

## Approach

### V1 scope

Keep v1 deliberately narrow:

- provide a `session_search` **tool**
- provide one explicit **reindex/onboarding** path
- keep search results at **session granularity**
- do all indexing work either during full reindex or during runtime hooks
- make the search path itself do no indexing, reconciliation, or repair work

V1 does **not** include:

- a human-facing `/session-search` search command
- public branch-level result rows
- lineage features beyond whatever raw session metadata is naturally present
- query-time health checks, self-healing, or incremental refresh
- bash-based file-change inference
- embeddings / semantic retrieval
- thinking-block indexing

### New package, not a `pi-amplike` enhancement

Implement this as a new Pi package rather than extending `pi-amplike`.

Working assumption for the plan:

- package name: `pi-sessions`

The package should own:

- the `session_search` tool
- the `session_ask` tool
- the reindex/onboarding entrypoint
- the sidecar index
- the hook-driven writer for future sessions

### Search and follow-up surfaces

Resolved decisions:

- `session_ask` should always read the **entire session tree** in v1
- the admin surface should act like a small control panel rather than a bare dangerous command

Add a new discovery tool:

```ts
session_search({
  query?: string,
  files?: {
    touched?: string[]
  },
  repo?: string,
  cwd?: string,
  time?: {
    after?: string,
    before?: string
  },
  limit?: number
})
```

Current visible output is intentionally compact and grouped by cwd. A typical rendered block looks like:

```text
cwd: /path/to/repo
Title or [unnamed]: session-id
Title or [unnamed]: session-id
```

Additional `matched_files`, `score / hits`, and `snippet` lines appear only when relevant.

The underlying result rows still carry:

- `sessionId`
- `sessionName`
- `sessionPath`
- `cwd`
- `repoRoots`
- `startedAt`
- `modifiedAt`
- `snippet`
- `matchedFiles`
- `score`

Add a new follow-up analysis tool:

```ts
session_ask({
  sessionPath: string,
  question: string // required, non-empty
})
```

Recommended v1 behavior for `session_ask`:

- keep the small, direct tool surface of the older `session_query`
- load and render the **entire session tree**, not just a single branch path
- use the `bdsqqq/dots` `read-session` design as the stronger architectural reference
- avoid extra branch-targeting parameters in v1

V1 intent:

- `session_search` finds the right prior session
- `session_ask` interrogates that chosen session by reading the full tree
- this package should not depend on the older `session_query` tool remaining enabled

### Onboarding path

Provide one explicit admin/control-panel entrypoint for existing sessions.

Working assumption:

- `/session-index`

Expected v1 behavior:

- open a lightweight modal/status UI
- show index status and basic metadata
- allow pressing `r` to request reindex
- on `r`, open a confirmation modal before starting the expensive rebuild

So the expensive action remains explicit, but the default command surface becomes an admin control panel rather than a bare status/no-op command.

The reindex action's job is to:

1. discover all existing session `.jsonl` files under `~/.pi/agent/sessions/`
2. parse each session file as a whole tree
3. extract session metadata, searchable text, and file-touch metadata
4. build a brand-new sidecar SQLite DB in a temp path
5. atomically swap the rebuilt DB into place

This is both the bootstrap path and the recovery path if hook coverage was absent for some period.

### Hook-maintained future coverage

For future sessions, rely on hooks as the normal write path.

If the hooks are enabled and functioning correctly, they should fully cover future sessions. If the user disables them, the recourse is explicit full reindex.

Important hooks for v1:

- `session_start`
- `session_switch`
- `tool_call`
- `tool_result`
- `turn_end`
- `session_tree`
- `session_compact`
- `session_shutdown`

Recommended responsibilities:

- `session_start` / `session_switch`
  - attach writer state to the active session file
  - capture current `cwd`
- `tool_call`
  - stage `read` / `edit` / `write` file-touch candidates
- `tool_result`
  - finalize staged file-touch metadata and capture truncated result text
- `turn_end`
  - flush per-turn textual content and metadata to the sidecar DB
  - recompute repo membership for any new touched paths seen during the turn
- `session_tree`
  - persist new summary text and branch-related searchable content
- `session_compact`
  - ingest compaction summary text and `details.{readFiles, modifiedFiles}`
- `session_shutdown`
  - final flush and clean close

Search itself should only:

1. open the sidecar DB
2. run the query
3. return ranked session rows

Nothing else.

### Session granularity only

For v1, the public retrieval unit is the **session**, not the branch.

The index may still parse the whole session tree internally, but the public result set should collapse to one row per session.

When many chunks from the same session match, that session's score should be boosted rather than returning duplicate rows. In other words:

- more independent hits within one session should raise confidence
- public output should still be one session row

### Repo and path model

Do **not** assume one `repo_root` per session.

A session may:

- start in a folder that is not itself inside a repo
- touch files in multiple repos
- begin outside a repo and later create one with `git init`

V1 should therefore treat repo membership as derived metadata attached to touched paths and then aggregated up to the session as a **set of repo roots**.

Store:

- `repoRoots[]` per session
- `repoRoot` / `repoRelPath` per indexed file-touch row when derivable

Rules:

- if `cwd` is inside a repo, record that repo in the session's repo set
- if `cwd` is not inside a repo, leave the session repo set empty until touched paths reveal repo membership
- during both full reindex and hook flushes, derive repo membership from newly seen absolute paths
- if a session starts outside a repo and later `git init` happens, later hook flushes should see the new repo root and add it to the session repo set

This avoids the incorrect assumption that `cwd` always maps cleanly to one repo.

### File-touch identification

Use a layered model.

Primary signal:

- assistant tool calls for `read(path)`, `edit(path)`, and `write(path)`

Secondary signal:

- `branch_summary.details.readFiles`
- `branch_summary.details.modifiedFiles`
- `compaction.details.readFiles`
- `compaction.details.modifiedFiles`

These summaries are still worth indexing, but they matter less than they would in a branch-oriented design because v1 already searches the full session tree and returns one session row.

Do **not** use for canonical file-touch inference in v1:

- bash heuristics
- free-text path mentions
- shell-derived Git diff inference

### Sidecar storage

Use a local SQLite database with FTS5.

Current location:

```text
~/.pi/agent/pi-sessions/index.sqlite
```

This follows the same general `~/.pi/agent/...` convention as Pi's built-in stores while giving the new package its own clearly named directory instead of a generic `cache/` bucket.

### Tooling

Use a modern but boring TS toolchain that matches what this repo is already using for Pi extensions.

Recommended v1 stack:

- **Biome** for formatting + linting
- **TypeScript (`tsc`)** for strict type-checking
- **Vitest** for unit and integration tests

Rationale:

- Biome is already present in this repo's TS extension work and is the simplest current formatter/linter choice here
- strict `tsc --noEmit` remains the clearest type-safety gate; no need to chase newer experimental compilers for this package
- Vitest is the popular, current TS test choice and gives a smoother path for mocking, temp DB tests, and extractor tests than inventing custom harnesses

Observed alternative from `bdsqqq/dots`:

- `oxfmt` + `oxlint`
- `typescript`
- `vitest`
- `tsdown`

That stack is reasonable, but the local repo already uses Biome for Pi extension work, so Biome is still the better fit here unless there is a strong reason to standardize on the Oxc toolchain instead.

Explicit non-choice for v1:

- no `tsgo` or other experimental compiler/runtime substitutions

### SQLite dependency

Working assumption for v1:

- `better-sqlite3`

What it is:

- a native Node.js SQLite binding
- synchronous API
- commonly used for local agent-side indexes and caches
- ships SQLite support, including FTS5 in normal builds

Expected non-core TS/runtime deps for v1:

- `better-sqlite3`
- `@types/better-sqlite3`

No ORM is planned.
No extra fuzzy-search dependency is planned for v1.

### Database contents

Keep the DB narrow.

#### Table: `sessions`

One row per session file.

Fields:

- `session_id`
- `session_path`
- `session_name`
- `cwd`
- `repo_roots_json`
- `created_ts`
- `modified_ts`
- `message_count`
- `entry_count`
- `index_version`
- `indexed_at_ts`
- `index_source` (`full_reindex` or `hook`)

#### Table: `session_text_chunks`

Searchable text fragments associated with a session.

Fields:

- `session_id`
- `entry_id` nullable
- `entry_type`
- `role` nullable
- `ts`
- `source_kind`
- `text`

Recommended `source_kind` values:

- `user_text`
- `assistant_text`
- `custom_message`
- `branch_summary`
- `compaction_summary`
- `tool_result`
- `bash_command`
- `bash_output`

Back this with FTS5.

#### Table: `session_file_touches`

File-touch metadata associated with a session.

Fields:

- `session_id`
- `entry_id` nullable
- `op` (`changed` | `read`)
- `source` (`tool_call` | `compaction_details` | `branch_summary_details`)
- `raw_path`
- `abs_path`
- `cwd_rel_path`
- `repo_root`
- `repo_rel_path`
- `basename`
- `path_scope`
- `ts`

Public query semantics expose only `files.touched`, which matches both `read` and `changed` rows.

### Exact text inclusion policy

Include fully:

- session name
- user text blocks
- assistant text blocks
- branch summary text
- compaction summary text
- custom message text
- bash command input text

Include truncated to 500 chars:

- tool result text
- bash output text

Exclude:

- thinking blocks
- images / binary payloads
- non-textual payloads

### Search semantics

Hard filters first:

- repo
- cwd
- time range
- file filters

Then lexical ranking over text chunks.

Current text semantics:

- quoted text = phrase query
- plain text = lexical FTS query
- session name gets a modest boost
- snippets come from the best matching chunk

Current file semantics:

- public file filter is `files.touched`
- absolute query → exact/suffix on `abs_path`
- path with `/` → exact/suffix on `repo_rel_path` and `cwd_rel_path`
- basename-only query → exact on `basename`, lower confidence

Current time semantics:

- invalid `after` / `before` values are rejected
- `limit` defaults to `10` and must be greater than `0`
- each session is treated as a time range from `created_ts` to `modified_ts`
- a time-filtered search matches sessions whose time range overlaps the query range

When collapsing many hits from one session into one row:

- increase score for multiple independent matches
- prefer sessions with hits across both text and file-touch evidence
- still return one row per session
- when no text/file evidence exists, sessions are ordered newest-first

### Failure model

Keep failure handling minimal in v1.

If the sidecar DB is missing or schema-incompatible:

- fail closed
- tell the user to run the explicit reindex entrypoint

Do not perform query-time repair.
Do not inspect raw session files during search.
Do not add separate health-check machinery in v1.

## Files to Modify

### New package: `pi-sessions`

Current package structure:

- `pi-sessions/package.json`
- `pi-sessions/README.md`
- `pi-sessions/SMOKE.md`
- `pi-sessions/biome.json`
- `pi-sessions/tsconfig.json`
- `pi-sessions/vitest.config.ts`
- `pi-sessions/extensions/session-search.ts`
- `pi-sessions/extensions/session-ask.ts`
- `pi-sessions/extensions/session-index.ts`
- `pi-sessions/extensions/session-hooks.ts`
- `pi-sessions/extensions/session-search/db.ts`
- `pi-sessions/extensions/session-search/reindex.ts`
- `pi-sessions/extensions/session-search/hooks.ts`
- `pi-sessions/extensions/session-search/extract.ts`
- `pi-sessions/extensions/session-search/normalize.ts`
- `pi-sessions/test/session-search.extract.test.ts`
- `pi-sessions/test/session-search.db.test.ts`
- `pi-sessions/test/session-search.reindex.test.ts`
- `pi-sessions/test/session-search.hooks.test.ts`
- `pi-sessions/test/session-search.normalize.test.ts`
- `pi-sessions/test/session-search.tool.test.ts`
- `pi-sessions/test/session-ask.test.ts`

No custom skill is planned for v1. The package should expose tools and package README documentation, but a skill is unnecessary unless we later find the model needs extra prompting to discover or sequence the tools correctly.

### Local configuration in this repo

- `chezmoi/private_dot_pi/agent/settings.json.tmpl`
  - add the new package source once it exists

## Reuse

Existing Pi behavior and structures to reuse:

- Pi session file format and tree semantics
  - `/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/docs/session.md`
  - `/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/docs/tree.md`
- Pi package conventions
  - `/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/docs/packages.md`
- Existing `session_query` implementation as one reference for the new `session_ask` tool
  - local path: `/Users/thurstonsand/.pi/agent/git/github.com/pasky/pi-amplike/extensions/session-query.ts`
  - upstream repo: `https://github.com/pasky/pi-amplike`
- `bdsqqq/dots` session search implementation as a reference for search/indexing structure
  - source file: `https://raw.githubusercontent.com/bdsqqq/dots/main/user/pi/packages/extensions/search-sessions/index.ts`
  - upstream repo: `https://github.com/bdsqqq/dots/tree/main/user/pi`
- `bdsqqq/dots` session read implementation as a reference for the new `session_ask` tool
  - source file: `https://raw.githubusercontent.com/bdsqqq/dots/main/user/pi/packages/extensions/read-session/index.ts`
  - upstream repo: `https://github.com/bdsqqq/dots/tree/main/user/pi`
- `bdsqqq/dots` shared session parsing/index helpers as a reference for extraction and tests
  - source files:
    - `https://raw.githubusercontent.com/bdsqqq/dots/main/user/pi/packages/core/mentions/session-index.ts`
    - `https://raw.githubusercontent.com/bdsqqq/dots/main/user/pi/packages/core/mentions/session-index.test.ts`
  - upstream repo: `https://github.com/bdsqqq/dots/tree/main/user/pi`
- Built-in file-op extraction logic used for compaction and branch summaries
  - `/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/dist/core/compaction/utils.js`
- SessionManager behavior and persisted leaf reconstruction
  - `/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/dist/core/session-manager.js`

## Steps

### Phase 1 — package scaffold + strict tooling + full reindex bootstrap

Deliverable: a new `pi-sessions` package with modern TS tooling, a complete sidecar DB built from existing sessions, a control-panel-style `/session-index` command, and `session_search` / `session_ask` working for text-oriented flows.

- [x] Scaffold `pi-sessions` package with extension layout
- [x] Add `package.json`, `biome.json`, `tsconfig.json`, and `vitest.config.ts`
- [x] Configure Biome formatting/linting, strict `tsc --noEmit`, and Vitest
- [x] Add SQLite schema and DB open/create logic
- [x] Add full-reindex builder that scans all session JSONL files
- [x] Index session rows and text chunks only
- [x] Add `session_search` tool with text + time + cwd filters against the sidecar DB
- [x] Add initial `session_ask` tool, using the older `session_query` surface plus the stronger whole-tree `read-session` architecture as the combined reference
- [x] Add `/session-index` modal/status UI with `r` → confirm → reindex flow
- [x] Add unit/integration tests for extraction, DB creation, and reindex bootstrap
- [x] Add a live smoke test path for loading the extension into Pi and exercising `/session-index`, reindex, and a basic search/ask flow

This phase should be committable and useful on its own, even before file-touch indexing or hooks exist.

### Phase 2 — file-touch indexing + repo-set derivation

Deliverable: reindex now captures file-touch metadata and repo sets, and search supports repo filtering plus a simplified public `files.touched` filter.

- [x] Add file-touch extraction from raw tool-call history
- [x] Ingest `branch_summary.details` and `compaction.details`
- [x] Add path normalization and repo-root derivation helpers
- [x] Store session-level `repoRoots[]` and file-touch-level repo metadata
- [x] Add file and repo filters to `session_search`
- [x] Add scoring boost for sessions with multiple independent hits
- [x] Add unit/integration tests for path normalization, repo-set aggregation, and file-touch extraction
- [x] Add a live smoke test path for searching known historical sessions by touched file and repo filter

This phase should remain cleanly committable without requiring hook-based freshness yet.

### Phase 3 — hook-maintained future coverage

Deliverable: once full reindex has been run once, future sessions stay current through hooks, with search still doing zero indexing work.

- [x] Add hook-driven writer state for the active session
- [x] Implement `tool_call` staging and `tool_result` finalization
- [x] Implement `turn_end` flush logic
- [x] Implement `session_tree` and `session_compact` ingestion
- [x] Implement `session_start` / `session_switch` attachment and `session_shutdown` final flush
- [x] Ensure repo-set derivation also runs on hook flushes so new repos and `git init` cases are captured
- [x] Add unit/integration tests for hook staging, flushes, and repo-set updates during new-session activity
- [x] Add a live smoke test path that loads the extension into Pi, performs fresh `read` / `edit` / `write` operations, and confirms the new session is searchable without rerunning reindex

This phase should be committable without needing any search-path changes.

### Phase 4 — documentation and verification polish

Deliverable: docs explain the lifecycle clearly and the package is ready to install.

- [x] Document the onboarding/reindex workflow
- [x] Document the hook-maintained future-session model
- [x] Document the failure model: if hooks were disabled, run reindex
- [x] Update package README
- [x] Add final examples for `session_search` and `session_ask`
- [x] Add a final end-to-end smoke test recipe covering reindex, search, ask, and hook-maintained freshness

## Verification

### Per-phase automated coverage

Each phase should land with both automated tests and a smoke-test recipe.

Recommended automated layers:

- **unit tests** for path normalization, extractors, and score aggregation
- **integration tests** for SQLite schema, full reindex, hook flushes, and query behavior against temp fixtures
- strict `tsc --noEmit`
- Biome lint/format checks

### Phase 1 smoke test

- load the new extension package into Pi
- open `/session-index`
- confirm the modal shows index status
- trigger reindex via `r`, then confirm in the follow-up modal
- confirm the DB is created under `~/.pi/agent/pi-sessions/`
- confirm a known old session is searchable by text
- confirm `session_ask` can interrogate a chosen indexed session by reading the full tree

### Phase 2 smoke test

- rerun full reindex
- confirm a known old session is searchable by `files.touched`
- confirm repo filtering works for at least one known repo-backed session
- confirm sessions with multiple hits get stronger ranking than single-hit sessions where appropriate

### Phase 3 smoke test

- load the extension into a live Pi session
- perform `read`, `edit`, and `write` operations
- confirm the new session is searchable without rerunning reindex
- branch with `/tree`, trigger compaction if practical, and confirm summary text becomes searchable
- if useful, use a live-control helper like `tmux-cli` to exercise the flow end-to-end while Pi is running interactively

### Repo/path edge cases

- start a session in a folder outside Git and later `git init`
- start a session in a parent folder that touches files in multiple repos
- confirm `repoRoots[]` on the session captures the correct set after hook flushes or reindex

### Failure path

- temporarily move or invalidate the sidecar DB
- confirm `session_search` fails closed and directs the user to run reindex
