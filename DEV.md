# DEV.md

## Commands

```bash
# Full quality gate — run before committing
npm run check

# Individual steps
npm run lint
npm run format
npm run typecheck
npm test

# Single test by name pattern
npm test -- -t "creates schema and reports status"

# Single test file
npm test -- test/session-search.extract.test.ts
```

No build/compile step — The pi framework loads extensions directly from TypeScript source.

## Code Style

- All extension registration (`pi.on`, `pi.register*`) should exist only in `install.ts` files
- Use TypeBox to ensure runtime type safety
- Do not change production types to make tests easier; mock the real type instead.
- Treat the SQLite index as a read-layer cache; anything durable must be stored within the session file directly
- Never be afraid to break backwards compatibility if it serves to better solve the current goal
- Avoid `Pick`, `Omit`, `Partial`, `ReturnType`, indexed-access type derivations like `Foo["bar"]`, other kinds of utility-type derivations unless they are clearly justified.

## Gotchas

- Wrap multi-step writes in transactions and run them with `db.transaction(fn).immediate()` — a deferred read-then-write transaction fails with `SQLITE_BUSY` on the snapshot upgrade
- SQLite is accessed via `bun:sqlite` when using bun as the runtime, `better-sqlite3` otherwise
- use `.ts` extensions for repo-local imports

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
- **Shared utilities**: no primary entrypoint; core logic at `extensions/shared/`.
