# DEV.md

## Setup

```sh
mise trust && mise bootstrap
```

## Commands

```sh
mise run lint
mise run format
mise run typecheck
mise run test
mise run build:broker
mise run check      # full verification gate
mise run smoke      # isolated real Pi/tmux integration; see SMOKE.md
mise run bench      # repeatable indexing/search/hook measurements; see SMOKE.md
```

Single test file:

```sh
mise run test -- test/session-search.extract.test.ts
```

Pi loads extension code directly from TypeScript source. Only the detached messaging broker is compiled, by `build:broker`, and committed to repo in `dist/`.

## Code Style

- All extension registration (`pi.on`, `pi.register*`) should exist only in `install.ts` files. Implementations should be in sibling modules.
- Use TypeBox to ensure runtime type safety
- Do not change production types to make tests easier; mock the real type instead.
- Treat the SQLite index as a read-layer cache; anything durable must be stored within the session file directly
- Never be afraid to break backwards compatibility if it serves to better solve the current goal

## Gotchas

- Wrap multi-step writes in `db.transaction(fn)` which enforces immediate — a deferred read-then-write transaction fails with `SQLITE_BUSY` on the snapshot upgrade
- SQLite is accessed via each runtime's built-in driver: `bun:sqlite` under bun, `node:sqlite` otherwise
- Index callers use `withSessionIndex`: it validates schema, starts recovery on a miss, and leaves write serialization to SQLite's own `BEGIN IMMEDIATE` lock. The companion `.lock.sqlite` serializes rebuilds only; a rebuild copies into a valid index in place, and renames a new file in only when the index is missing or corrupt, so open connections never point at a replaced inode. Writers keep whatever journal mode the file has, since leaving WAL fails at once while any other connection is open; only a rebuild converts the index to rollback journals, and renamed-in files are always rollback-journal, with the corrupt path moving old sidecars aside. A writer blocked by another process's rebuild waits for it with no timeout, then redoes once; any other busy writer throws after `busy_timeout`. Never unlink the companion `.lock.sqlite`; SQLite releases its lock when a process exits.
- use `.ts` extensions for repo-local imports
- the broker runs under raw Node with no `node_modules` beside it; nothing in its import graph may import a package, TypeBox included
- pi tracks `main` for git installs, so every commit must carry a `dist/` that matches its source; the pre-commit hook rejects a stale one

## Project structure

- **Composition root**: `extensions/pi-sessions.ts`; feature-toggle and dependency-wiring logic. Should be the only place where `session_start`/`session_shutdown` subscription exists.
- **Shared ports** at `extensions/shared/composition.ts`.
- **Session search**: `extensions/session-search/install.ts`; result rendering at `extensions/session-search/renderer.ts`; core logic at `extensions/session-search/` and `extensions/shared/session-index/`.
- **Session ask**: `extensions/session-ask/install.ts`; navigation agent logic at `extensions/session-ask/`; retrieval support at `extensions/shared/session-index/`.
- **Session index**: `extensions/session-index/install.ts`; recovery and reconciliation at `extensions/shared/session-index/recovery.ts`.
- **Session hooks**: `extensions/session-hooks/install.ts`; incremental sync at `extensions/shared/session-index/sync.ts`. Startup/switch sync runs independently of feature toggles.
- **Session handoff**: `extensions/session-handoff/install.ts`; core logic at `extensions/session-handoff/`.
- **Hosts**: v2 peer-ownership event contract and synchronous registration at `extensions/hosts/`; the composition root discovers claims at each session start before registering peer tools.
- **Session messaging**: `extensions/session-messaging/install.ts` owns transport; `directory.ts` implements peer and subagent addressability. `pi/directory-tools.ts` builds both sets through shared tool execution and presenters; `pi/install.ts` owns late registration and active-tool transitions. `message-router.ts` only coordinates owned subagent wake/recovery, never host ownership.
- **Lineage**: public custom-entry schema at `extensions/shared/lineage.ts`; extraction at `extensions/session-search/extract.ts`, incremental/full indexing at `extensions/shared/session-index/sync.ts`.
- **Session reference picker**: `extensions/session-handoff/install.ts`; core logic at `extensions/session-handoff/picker.ts` and `extensions/session-handoff/query.ts`.
- **Session auto-title**: `extensions/session-auto-title/install.ts`; core logic at `extensions/session-auto-title/`.
- **Subagents**: `extensions/subagents/install.ts`; worker runtimes (tmux, Herdr) at `extensions/subagents/worker-runtime.ts` over `extensions/shared/tmux.ts` and `extensions/shared/herdr.ts`; launch and wake behavior, task reporting, recursive child lifecycle, classification, roster traversal, and lifecycle reconciliation at `extensions/subagents/`.
- **Shared utilities**: no primary entrypoint; core logic at `extensions/shared/`.
