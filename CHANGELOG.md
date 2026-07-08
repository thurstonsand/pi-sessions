# Changelog

## [0.8.0] - 2026-07-08

### Added

- Added `sessions.autoTitle.timeoutSecs` setting to configure the auto-title request timeout; default stays 15s.

## [0.7.2] - 2026-07-08

### Changed

- Tightened the tool prompt copy for `session_ask`, `session_handoff`, `session_search`, and `session_send_message` so the injected agent guidance is terser and more consistent.

## [0.7.1] - 2026-07-06

### Fixed

- Fixed session messaging on the Bun-compiled Pi release binary, where starting Pi spawned an unbounded series of agent sessions instead of the messaging broker; the broker now launches once and messaging works under Bun.
- Fixed the detached broker failing to resolve `typebox` in `--omit=dev` installs by moving it to a runtime dependency.

## [0.7.0] - 2026-07-05

- **Reworked session search** - Boolean query parsing, BM25/recency-scored ranking, and evidence arrays replace ad hoc filtering and single-snippet matches.
- **Live session discovery** - `session_search` can now find currently running sessions with `live: true`, replacing the separate `session_list_live` tool.
- **`session_ask` session navigation** - A focused sub-agent reads a session in a loop, so `session_ask` even works on large sessions that cover many compactions.

### Added

- Added a boolean query parser/compiler for SQLite FTS5 with bounded BM25/recency-based ranking for `session_search`.
- Added query relaxation for unquoted multi-term searches so an absent adjacent term no longer voids the whole match.
- Added `live: true` to `session_search` for finding currently running sessions through the same index-backed search surface, filters, ranking, and lineage as historical recall.
- Added a navigation sub-agent for `session_ask` that searches and reads through sessions in bounded, paginated chunks instead of rendering whole session trees into one prompt.

### Changed

- Changed `session_search` results to expose `evidence` arrays for text snippets and file touches instead of `matchedFiles`.
- Changed current-session search to surface freshly indexed hook evidence as `relation:self`, so compacted/current-session recall works even when the index is correct but was previously hidden.
- Changed the session index schema from v8 to v12; run `/session-index` and rebuild after upgrading.
- Changed broker protocol frames to carry bare session ids instead of session metadata; kill any old broker process before using the new messaging client.
- Changed `session_send_message` incoming message receipts to enrich source/target/relation from the session index at delivery time instead of stale broker-registered metadata.

### Removed

- Removed `session_list_live`; use `session_search` with `live: true` instead.

## [0.6.0] - 2026-07-02

- **Live session messaging** - `session_send_message` and `session_list_live` let running Pi sessions coordinate directly, with incoming messages starting idle sessions or steering active ones.

### Added

- Added `session_list_live` and `session_send_message` pi tools for agent-to-agent coordination.
- Added `session_handoff.requestResponse` so child sessions can be asked to report back when complete.
- Added a local broker to handle the communication between pi instances.

### Changed

- Changed incoming messages to start idle sessions or steer active sessions.
- Raised the Node requirement to `>=24 <26`.

## [0.5.1] - 2026-06-25

### Changed

- Bumped Pi dependencies to `0.80.2`.

## [0.5.0] - 2026-06-18

- **Background session handoffs** - The `session_handoff` tool launches child sessions into a new Ghostty split while the current session keeps working, with a review countdown before the handoff prompt runs.

### Added

- Added the `session_handoff` tool for Ghostty/macOS background handoffs.
- Added `/handoff --identify` to refresh the Ghostty source pane used for background handoffs.
- Added optional target working directories for handoffs into related repos.

### Changed

- Changed tool-launched child sessions to collect context and show the handoff review countdown in the new split while the current session continues.

## [0.4.1] - 2026-06-12

### Changed

- Changed `/handoff` to use a read-only Pi extraction agent so generated handoff prompts can include relevant file context from the workspace.

## [0.4.0] - 2026-06-12

- **Reliable concurrent indexing** - Hook-maintained index writes now queue through immediate SQLite transactions with busy timeouts, and incremental sync skips unchanged sessions instead of re-indexing everything.

### Added

- Added incremental hook sync so unchanged sessions are skipped and appended session JSONL is indexed without rewriting existing rows.

### Changed

- Changed text search to use external-content FTS5 triggers so indexed text stays in lockstep with stored chunks.
- Reduced lineage refresh work to the affected session family during hook updates.
- Bumped the session index schema to version 8; rebuild the index with `/session-index` if needed.

### Fixed

- Fixed hook-maintained index writes under concurrent Pi processes by queueing writes with immediate SQLite transactions and connection-level busy timeouts.

## [0.3.2] - 2026-06-09

- **Bun-compatible session indexing** - The session index SQLite backend now runs under Bun while preserving Node support through `better-sqlite3`.

### Added

- Added Bun runtime support for the session index SQLite backend while preserving Node support through `better-sqlite3`.

### Changed

- Changed handoff draft generation to reuse the active session thinking level when the selected model supports reasoning.

### Fixed

- Fixed rebuilt index files to be self-contained by checkpointing WAL data before replacing the live index.
- Fixed package installation to be more tolerant when Husky is unavailable.

## [0.3.1] - 2026-06-04

### Added

- Added a repo-local npm release skill for future release workflow guidance.

### Changed

- Raised Pi peer/dev dependencies to `0.78.1`.

### Fixed

- Fixed TUI-only command panels to check Pi's explicit extension mode so RPC, JSON, and print modes do not enter custom TUI flows.

## [0.3.0] - 2026-05-31

- **Configurable auto-title prompt** - `sessions.autoTitle.prompt` lets you customize the generated title style, with titles now capped at 80 characters.

### Added

- Added `sessions.autoTitle.prompt` so users can customize generated title style.

### Changed

- Capped generated auto-titles at 80 characters.
- Raised Pi peer/dev dependencies to `0.78.1`.

### Fixed

- Fixed plain `/handoff` to wait for the old transcript to clear before the approved prompt starts.

## [0.2.2] - 2026-05-09

### Changed

- Migrated Pi peer/dev dependencies and imports from `@mariozechner/*` to `@earendil-works/*`.
- Migrated TypeBox imports from `@sinclair/typebox` to `typebox` for Pi 0.69+ compatibility.
- Added a Node engine range matching current `better-sqlite3` support and pinned local development to Node 24.
- Refreshed direct development dependencies and lockfile metadata.

## [0.2.1] - 2026-04-26

### Added

- Added bounded retries and a short SQLite busy timeout for hook-maintained index writes.

### Changed

- Changed plain `/handoff` to send the approved prompt through `withSession.sendUserMessage()` after switching into the fresh replacement session.
- Raised Pi package peer/dev dependencies to `0.70.2` for replacement-session context support.
- Updated settings loading to use the current Pi settings API.
