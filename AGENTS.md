# AGENTS.md

## Project Overview

Pi extension package providing session search (FTS5), session ask (LLM-powered Q&A), command-driven session handoff, automatic session titling, and session index management. TypeScript, ES modules, SQLite via better-sqlite3.

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

No build/compile step — `noEmit: true` in tsconfig. The Pi framework loads extensions directly from TypeScript source.

## Project Structure

```
extensions/                  # All source code
  session-search.ts          # "session_search" tool entry point
  session-ask.ts             # "session_ask" tool entry point
  session-index.ts           # "session-index" command entry point
  session-hooks.ts           # Hook registration entry point
  session-handoff.ts         # "/handoff" command entry point
  session-auto-title.ts      # Auto-titling extension entry point
  session-search/            # Session search/index implementation
    extract.ts               # JSONL parsing, tree rendering, file-touch extraction
    reindex.ts               # Bulk index rebuild
    normalize.ts             # Path normalization and repo-root derivation
    hooks.ts                 # Hook controller and sync logic
  shared/
    session-index/           # Shared indexed-session backend
      common.ts              # Shared types, schemas, and search helpers
      schema.ts              # SQLite schema and metadata/status helpers
      store.ts               # Session/text/file-touch writes
      lineage.ts             # Lineage queries and materialization
      search.ts              # Search query pipeline and ranking
      index.ts               # Barrel export for the shared session-index module
  session-handoff/           # Handoff implementation
    extract.ts               # Structured extraction and draft assembly
    metadata.ts              # Session metadata resolution
    picker.ts                # Session reference picker overlay
    query.ts                 # Session picker query helpers
    refs.ts                  # @session ref resolution
    review.ts                # Preview overlay and review flow
  session-auto-title/        # Auto-titling implementation
    command.ts               # /title command parsing, completions, handler wrapper
    context.ts               # Conversation context extraction for title generation
    controller.ts            # Turn-counting trigger logic and state machine
    model.ts                 # Model resolution for title generation
    prompt.ts                # System and user prompts, title normalization
    retitle.ts               # Single and bulk retitle execution, scope scanning
    state.ts                 # Persisted state schema
    wizard.ts                # Interactive TUI wizard for multi-scope retitling
  shared/
    settings.ts              # File-backed config loading and resolved runtime settings
    time.ts                  # Shared compact relative-time formatting
    typebox.ts               # Shared TypeBox validation helpers
```

Entry points are thin wrappers that register tools/commands with the Pi extension API via default exports. Business logic lives in the corresponding subdirectories (`session-search/`, `session-handoff/`, `session-auto-title/`).

## Code Style

### TypeScript Approach

- Write idiomatic TypeScript for this codebase, not portable pseudocode with type annotations
- Prefer the patterns already used in nearby files over generic framework-agnostic abstractions
- Prefer explicit named types at module boundaries; infer obvious local variable types instead of adding noise
- Keep modules small and cohesive; prefer locality over utility dumping grounds
- Use plain functions and objects by default; do not introduce classes unless the existing code clearly needs them
- Add helper abstractions only when they remove real duplication or capture a real domain concept
- Before finishing, check: type shape clarity, unnecessary abstraction, naming quality, and consistency with nearby files

## Compatibility Policy

- Backward compatibility is not a goal in this repo unless the user explicitly asks for it
- Prefer conforming code to the current desired architecture and runtime contract over preserving legacy behavior
- Do not add compatibility shims, fallback aliases, or dual old/new codepaths unless explicitly requested

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
- Avoid barrel/re-export files unless they are the deliberate public entrypoint for a cohesive module
- No `export default` outside entry points

### Naming

- `camelCase` for variables, functions, parameters
- `PascalCase` for types, interfaces, classes
- `UPPER_SNAKE_CASE` for true constants (compile-time known values)
- Prefix unused params with underscore: `(_unused, needed) => ...`
- Boolean variables/params: use `is`, `has`, `should` prefixes
- Use descriptive names; avoid single-letter names except in tiny callback conventions already common in the file
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
- Use the real/named existing type by default, over utility-type derivations
- Avoid `Pick`, `Omit`, `Partial`, `ReturnType`, indexed-access type derivations like `Foo["bar"]`, etc. unless they are clearly justified
- If a type already has a clear named subtype or alias, use that directly instead of deriving it inline
- Exception: deriving TypeScript types from TypeBox schemas is preferred for TypeBox-owned runtime shapes
- Only introduce a smaller interface for a real runtime boundary, not field-trimming convenience
- Do not change production types to make tests easier; mock the real type instead
- No `any` — use `unknown` and narrow with type guards if the type is truly unknown
- No type assertions (`as`) unless unavoidable; add a comment explaining why

### Variables & Data

- `const` by default. `let` only when reassignment is necessary. No `var`.
- Infer local variable types when obvious; do not add annotations just to decorate
- Prefer immutable patterns: spread over mutation, `.map()` over push-loops
- Destructure when it improves clarity; don't destructure deeply nested structures
- No magic numbers or strings — extract to named constants

### Control Flow

- Prefer straightforward control flow over cleverness
- Early returns to reduce nesting
- `for...of` over index-based loops when index isn't needed
- No `for...in` on arrays
- Avoid nested ternaries — prefer `if`/`else` chains or `switch`
- Prefer `switch` with exhaustive cases for discriminated unions
- Guard clauses at the top of functions for preconditions

### Error Handling

- Match the surrounding module's existing error-handling conventions exactly
- `try`/`finally` for resource cleanup (especially `db.close()`)
- Avoid `try`/`catch` when possible — prefer result objects or framework-level error flow
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
- Do not compromise production-code cleanliness for tests
- Prefer pushing setup complexity into tests and mocks rather than introducing production abstractions purely for test convenience
- Dependency injection is acceptable as a narrow test seam

## Dependencies

- **Runtime**: `better-sqlite3` (SQLite driver)
- **Peer**: `@mariozechner/pi-ai`, `@mariozechner/pi-coding-agent`, `@mariozechner/pi-tui`, `@sinclair/typebox` — provided by the Pi host
- **Dev**: Biome, TypeScript, Vitest, type packages

## Settings

Global settings live under `sessions.*`.

- `sessions.index.dir` overrides the default index directory
  - default DB path: `~/.pi/agent/pi-sessions/index.sqlite`
  - must be an absolute path or start with `~/`
  - read from global settings only
- `sessions.handoff.pickerShortcut`
  - default: `alt+o`
  - read from global settings only
- `sessions.autoTitle.refreshTurns`
  - minimum `1`, default `4`
  - number of turns between automatic title refreshes
  - read from global settings only
- `sessions.autoTitle.model`
  - format: `provider/modelId`
  - optional; when unset, prefer internal cheap fallback models and then the active session model
  - read from global settings only
