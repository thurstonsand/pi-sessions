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

- Use TypeBox to ensure runtime type safety
- Do not change production types to make tests easier; mock the real type instead.
- Treat the SQLite index as a read-layer cache; anything durable must be stored within the session file directly
- Never be afraid to break backwards compatibility if it serves to better solve the current goal
- Avoid `Pick`, `Omit`, `Partial`, `ReturnType`, indexed-access type derivations like `Foo["bar"]`, other kinds of utility-type derivations unless they are clearly justified.

## Gotchas

- Wrap multi-step writes in transactions and run them with `db.transaction(fn).immediate()` — a deferred read-then-write transaction fails with `SQLITE_BUSY` on the snapshot upgrade
- SQLite is accessed via `bun:sqlite` when using bun as the runtime, `better-sqlite3` otherwise

## Project structure

- **Session search**: entrypoint at `extensions/session-search.ts`; core logic at `extensions/session-search/` and `extensions/shared/session-index/`.
- **Session ask**: entrypoint at `extensions/session-ask.ts`; core logic at `extensions/session-search/extract.ts` and `extensions/shared/session-index/`.
- **Session index**: entrypoint at `extensions/session-index.ts`; core logic at `extensions/session-search/reindex.ts` and `extensions/shared/session-index/`.
- **Session hooks**: entrypoint at `extensions/session-hooks.ts`; core logic at `extensions/session-search/hooks.ts`.
- **Session handoff**: entrypoint at `extensions/session-handoff.ts`; core logic at `extensions/session-handoff/`.
- **Session reference picker**: entrypoint at `extensions/session-handoff.ts`; core logic at `extensions/session-handoff/picker.ts` and `extensions/session-handoff/query.ts`.
- **Session auto-title**: entrypoint at `extensions/session-auto-title.ts`; core logic at `extensions/session-auto-title/`.
- **Shared utilities**: no primary entrypoint; core logic at `extensions/shared/`.
