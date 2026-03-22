# AGENTS.md

## Project Overview

Pi extension package providing session search (FTS5), session ask (LLM-powered Q&A),
and session index management. TypeScript, ES modules, SQLite via better-sqlite3.

## Commands

```bash
# Full quality gate — run before committing
npm run check        # biome check . && tsc --noEmit && vitest run

# Individual steps
npm run lint         # biome check .
npm run format       # biome format --write .
npm run typecheck    # tsc --noEmit
npm test             # vitest run

# Single test by name pattern
npm test -- -t "creates schema and reports status"

# Single test file
npm test -- test/session-search.extract.test.ts

# Watch mode
npm test -- --watch
```

No build/compile step — `noEmit: true` in tsconfig. The Pi framework loads
extensions directly from TypeScript source.

## Project Structure

```
extensions/                  # All source code
  session-search.ts          # "session_search" tool entry point
  session-ask.ts             # "session_ask" tool entry point
  session-index.ts           # "session-index" command entry point
  session-search/            # Core implementation
    db.ts                    # SQLite schema, queries, CRUD
    extract.ts               # JSONL parsing, tree rendering
    reindex.ts               # Bulk index rebuild
    normalize.ts             # Path normalization (stub)
    hooks.ts                 # Hook state types (stub)
```

Entry points are thin wrappers that register tools/commands with the Pi extension
API via default exports. Business logic lives in `extensions/session-search/`.

## Code Style

### Formatting

Run `npm run format` to auto-fix. Biome config is in `biome.json`.

### Imports

- ES modules only — no `require()`
- Sort imports: node builtins → external packages → internal modules
- Always include file extensions in relative imports (`.ts`, `.js`)
- No circular imports

### Exports

- Extension entry points: `export default function extensionName(pi: ExtensionAPI)`
- Everything else: named exports
- No barrel/re-export files
- No `export default` outside entry points

### Naming

- `camelCase` for variables, functions, parameters
- `PascalCase` for types, interfaces, classes
- `UPPER_SNAKE_CASE` for true constants (compile-time known values)
- Prefix unused params with underscore: `(_unused, needed) => ...`
- Boolean variables/params: use `is`, `has`, `should` prefixes
- Name functions for what they return or do — `getSessionCount`, `indexSession`

### Functions

- Use `function` declarations for all named, top-level, and exported functions
- Arrow functions are fine for inline callbacks, `.map()`, `.filter()`, etc.
- Explicit return type annotations on all top-level and exported functions
- Async operations use `async`/`await` — no raw `.then()` chains
- Keep functions short. If a function needs a comment to explain a section, that section is a candidate for extraction
- Prefer early returns over deep nesting
- No nested ternaries — use `if`/`else` or `switch` for multiple conditions

### Types

- `interface` for data shapes and object structures
- `type` for unions, intersections, mapped types, and aliases
- All function parameters and return types explicitly typed
- Define types for any JSON or external data before using it
- Prefer narrow types over broad ones (`string` literals over `string` where possible)
- No `any` — use `unknown` and narrow with type guards if the type is truly unknown
- No type assertions (`as`) unless unavoidable; add a comment explaining why

### Variables & Data

- `const` by default. `let` only when reassignment is necessary. No `var`.
- Prefer immutable patterns: spread over mutation, `.map()` over push-loops
- Destructure when it improves clarity; don't destructure deeply nested structures
- No magic numbers or strings — extract to named constants

### Control Flow

- Early returns to reduce nesting
- `for...of` over index-based loops when index isn't needed
- No `for...in` on arrays
- Avoid nested ternaries — prefer `if`/`else` chains or `switch`
- Prefer `switch` with exhaustive cases for discriminated unions
- Guard clauses at the top of functions for preconditions

### Error Handling

- `try`/`finally` for resource cleanup (especially `db.close()`)
- Avoid `try`/`catch` when possible — prefer result objects
- Empty `catch` blocks must have a comment explaining why they're empty
- Return error status via result objects: `{ error: true, message: "..." }`
- Graceful degradation with meaningful fallbacks over thrown exceptions
- No custom error classes in this codebase
- Never swallow errors silently — log or return them

### SQLite Patterns

- Use prepared statements — no string interpolation in queries
- Wrap multi-step writes in transactions
- Use `WAL` journal mode for concurrent read access

### Comments

Code should be self-documenting. Comments explain _why_, not _what_.

- No JSDoc
- No changelog comments in source
- No restating what the code already says
- Non-obvious decisions and workarounds get a brief comment
- If you need a comment to explain _what_ code does, refactor the code instead

## Testing

Framework: Vitest. Tests live in `test/` with `*.test.ts` naming.

Patterns used in this codebase:

- `describe` / `it` / `expect` (Vitest globals)
- Temp directories via `mkdtempSync`, cleaned up in `afterEach`
- Mocking with `vi.mock()` and `vi.fn()`
- Direct imports of source functions under test
- No snapshot tests

## Dependencies

- **Runtime**: `better-sqlite3` (SQLite driver)
- **Peer**: `@mariozechner/pi-ai`, `@mariozechner/pi-coding-agent`,
  `@mariozechner/pi-tui`, `@sinclair/typebox` — provided by the Pi host
- **Dev**: Biome, TypeScript, Vitest, type packages

## Environment

- `PI_SESSIONS_INDEX_DIR` overrides the default index directory
  (`~/.pi/agent/pi-sessions/index.sqlite`)
