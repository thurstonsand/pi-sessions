# Changelog

<!-- markdownlint-disable MD024 -->

## [0.12.0] - 2026-08-04

- **Handoff model roster** - Handoffs now launch child sessions only on configured models.

### Added

- Added `sessions.handoff.roster`, listing the models a handoff may launch a child session on.

### Changed

- Changed the models a handoff may use when no roster is configured: it now follows pi's own `enabledModels` scoping, falling back to every authenticated model only when nothing is scoped.

## [0.11.2] - 2026-08-04

### Changed

- The handoff tool card only shows the resume command for deferred handoffs now. You can still copy the command from the `/handoff` pane.

### Fixed

- Subagents now start with `--approve` so they don't just hang forever waiting for user input to trust a folder.
- A handoff that fails to write its prompt now says why in the new session. It will retry on every startup until the first user message is sent.
- Handoff prompt generation now reports errors from the model provider.

## [0.11.1] - 2026-07-28

### Fixed

- Fixed a message referencing `session_search` when it should have been referencing `session_reachable`.

## [0.11.0] - 2026-07-28

- **Dependency-free install** - The session index moved to Node's built-in SQLite and the messaging broker ships pre-compiled, so pi-sessions now installs with no runtime dependencies and no native build step.

### Added

- Added `session_reachable` for listing the sessions the current session can address: `scope: "user"` for live user-facing sessions, `scope: "branch"` or `"tree"` for owned subagents. It ships with session messaging and needs no new toggle; when subagents are disabled the parameter disappears and the tool lists live sessions only.
- Added `sessions.autoTitle.tokenBudget` (default 64) for pointing auto-title at a model that reasons before answering, which otherwise spends the whole budget thinking and never reaches a title.
- Added `sessions.autoTitle.persistRuns` (default false), which records each title request as a standalone Pi session under `pi-sessions/session-auto-title/`, matching how session_ask and handoff already persist their runs.

### Changed

- `session_search` no longer accepts `live` or `relationScope`, and results no longer carry `state`, `depth`, `onActiveBranch`, or the `scope` totals block. Use `session_reachable` with the matching scope instead; `kind` still works. Search is now a pure index query.
- Changed the session index to use Node's built-in `node:sqlite` instead of better-sqlite3, removing the node-gyp compile that npm 12 blocks by default and that restricted registries could not satisfy. No reindex is required.
- Changed reachable-session discovery to exclude the current session and other sessions' subagents, and to read the subagent roster directly rather than intersecting it with the index, so a freshly launched worker shows up before the indexer catches it.
- Raised the minimum supported Pi version to 0.82.1 and made custom message renderers honor Pi's configured output padding; handoff kickoff, incoming message, and subagent report blocks no longer sit misaligned under a non-default `outputPad`.

### Fixed

- Fixed git installations never producing a messaging broker, which left session messaging and subagents unavailable. The compiled broker is committed to the repository, so it survives the `git clean` Pi runs on update, and it no longer loads TypeBox or anything else from `node_modules`.
- Fixed sibling subagents launched in the same turn racing to create their shared tmux session, where all but one failed with `duplicate session: pi-<id>` and only succeeded on a retry.
- Fixed handoff, session_ask, and auto-title dropping natively registered extension providers such as pi-claude-bridge, which made their models unresolvable in nested sessions.
- Fixed a full reindex aborting with `FOREIGN KEY constraint failed` when a session's parent transcript was not itself indexed.
- Fixed auto-title reporting "Model returned an empty title" when the model had actually exhausted its token budget; the failure now names the cause and points at `sessions.autoTitle.tokenBudget`.

### Removed

- Removed the undocumented `~/.pi/agent/pi-sessions/auto-title-debug.jsonl`, which mirrored whole conversation transcripts outside their session files and grew without bound. Nothing writes it anymore; delete any existing copy.

## [0.10.0] - 2026-07-26

### Added

- Added `sessions.handoff.model` and `sessions.handoff.thinkingLevel` settings for choosing the agent that builds handoff prompts.

### Fixed

- Fixed subagents shutting down while their own delegated children were still running, allowing nested delegation chains to wait for reports and complete normally.
- Fixed the session messaging broker failing to start from npm installations on Node.js 24 by packaging and consistently launching a compiled JavaScript broker.
- Fixed git installations never producing the compiled broker, which left session messaging and subagents unavailable; the compiled broker is now committed to the repository instead of built during installation.

## [0.9.0] - 2026-07-23

- **Background subagents** - Delegate work to detached tmux sessions with durable reports, follow-up messaging, cancellation, wake and recovery behavior, and lifecycle management from the handoff board.

### Added

- Added detached tmux subagents that report results to their parent, wake when messaged, recover missed reports, and can be cancelled or resumed after interruption.
- Added the `/handoff` board for inspecting and managing subagents and user-created child sessions.
- Added `session_cancel` for aborting another live session or stopping an owned subagent.
- Added `kind` and `relationScope` filters to `session_search` for finding user sessions or subagents globally, within the current branch, or across the session tree.
- Added model, thinking-level, and launch targeting to `session_handoff`, including deferred, tmux split, Ghostty split, and background subagent launches.
- Added durable handoff launch receipts, sent-message receipts, and model-visible handoff kickoff records.
- Added support for Pi's `max` thinking level and configurable auto-title thinking levels.

### Changed

- Changed `/handoff` to open the management board; launch new sessions through `session_handoff` instead.
- Renamed the `detached` launch target and related settings to `deferred`; use `launch: "deferred"` and `sessions.handoff.deferred.copyToClipboard`.
- Moved feature toggles from `sessions.features.<name>` to `sessions.<name>.enable`.
- Raised the minimum supported Pi version to `0.80.10` and consolidated package loading behind one composition-root extension; package users do not need to change their installation.
- Changed the session index schema to version 13; rebuild the index with `/session-index` after upgrading.

### Fixed

- Fixed `session_ask` cancellation leaving its nested agent running after the outer request was aborted.
- Fixed handoff children created for another working directory to use that project's default session directory, producing self-locating resume commands.

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
