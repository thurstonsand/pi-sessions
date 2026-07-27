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

- Wrap multi-step writes in transactions and run them with `db.transaction(fn).immediate()` — a deferred read-then-write transaction fails with `SQLITE_BUSY` on the snapshot upgrade
- SQLite is accessed via `bun:sqlite` when using bun as the runtime, `better-sqlite3` otherwise
- use `.ts` extensions for repo-local imports
- the broker runs under raw Node with no `node_modules` beside it; nothing in its import graph may import a package, TypeBox included
- pi tracks `main` for git installs, so every commit must carry a `dist/` that matches its source; the pre-commit hook rejects a stale one

## Project structure

- **Composition root**: `extensions/pi-sessions.ts`; feature-toggle and dependency-wiring logic. Should be the only place where `session_start`/`session_shutdown` subscription exists.
- **Shared ports** at `extensions/shared/composition.ts`.
- **Session search**: `extensions/session-search/install.ts`; result rendering at `extensions/session-search/renderer.ts`; core logic at `extensions/session-search/` and `extensions/shared/session-index/`.
- **Session ask**: `extensions/session-ask/install.ts`; navigation agent logic at `extensions/session-ask/`; retrieval support at `extensions/shared/session-index/`.
- **Session index**: `extensions/session-index/install.ts`; core logic at `extensions/session-search/reindex.ts` and `extensions/shared/session-index/`.
- **Session hooks**: `extensions/session-hooks/install.ts`; core logic at `extensions/session-search/hooks.ts`.
- **Session handoff**: `extensions/session-handoff/install.ts`; core logic at `extensions/session-handoff/`.
- **Session messaging**: `extensions/session-messaging/install.ts`; broker/client/runtime logic at `extensions/session-messaging/`.
- **Session reference picker**: `extensions/session-handoff/install.ts`; core logic at `extensions/session-handoff/picker.ts` and `extensions/session-handoff/query.ts`.
- **Session auto-title**: `extensions/session-auto-title/install.ts`; core logic at `extensions/session-auto-title/`.
- **Subagents**: `extensions/subagents/install.ts`; tmux launch and wake behavior, task reporting, recursive child lifecycle, classification, roster traversal, and lifecycle reconciliation at `extensions/subagents/`.
- **Shared utilities**: no primary entrypoint; core logic at `extensions/shared/`.
