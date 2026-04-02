# 06 — TypeBox runtime-boundary alignment plan

## Context

`pi-sessions` currently mixes three different approaches at dynamic boundaries:

- **Pi-owned runtime types** are sometimes re-declared locally instead of imported from Pi.
- **Manual narrowing** is used for settings, custom session metadata, tool-call payloads, and database row hydration.
- **TypeBox** is already present, but mostly for Pi-facing tool definitions rather than package-wide runtime validation.

The package already depends on Pi’s public types and helpers for several of the boundaries we care about:

- Pi exports session-file types and parsers such as `SessionHeader`, `SessionEntry`, `CustomEntry<T>`, `FileEntry`, and `parseSessionEntries`.
- Pi exports hook/event types and narrowing helpers such as `ToolCallEvent`, `ToolResultEvent`, `ReadToolCallEvent`, `WriteToolCallEvent`, and `isToolCallEventType(...)`.

That means the best-fit architecture is not “add a new schema system everywhere.” It is:

1. **Use Pi’s exported types directly where Pi already owns the contract**.
2. **Use TypeBox for repo-owned runtime boundaries that are still effectively dynamic**.
3. **Avoid redundant runtime validation for trusted SDK/provider/Pi contracts when the host already guarantees the type**.

## Problem Statement

We want stronger type safety at the real failure boundaries in `pi-sessions` without introducing a second schema system or re-validating data that Pi already owns.

The package needs a clear validation policy for:

- extension settings under `sessions.*`
- extension-owned custom session metadata
- LLM-produced structured handoff data
- SQLite row hydration and JSON columns
- explicit `unknown` cross-extension payloads

At the same time, the package should stop shadowing Pi’s own transcript and hook types locally when Pi already publishes stronger types for those boundaries.

## Goals

- align runtime validation with Pi’s existing TypeBox-based ecosystem
- keep **TypeBox** as the single repo-owned schema system
- use **Pi-exported types and helpers** for transcript files and hook events
- validate extension-owned dynamic data at the boundary where it enters package logic
- reduce `unknown` + ad hoc field walking + local shadow interfaces
- keep hot paths fast enough for index rebuilds and hook-driven incremental sync

## Non-Goals

- re-implement Pi’s transcript schema locally in full
- add runtime validation around every provider SDK result purely for symmetry
- wrap every SQLite write with a second validation layer when the input is already an internal typed domain object
- replace existing Pi-facing TypeBox tool definitions with another library

## Design Decisions

### 1. TypeBox becomes the package’s runtime-schema standard

`pi-sessions` will standardize on **TypeBox** for repo-owned runtime validation.

Reasons:

- Pi already uses TypeBox in tool definitions and exported tool-input types.
- `pi-sessions` already uses TypeBox today.
- Adding Zod would create a second schema language for little architectural benefit.
- TypeBox keeps runtime schemas, static inference, and Pi integration aligned.

This plan does **not** require TypeBox everywhere. It requires TypeBox specifically at package-owned dynamic boundaries.

### 2. Pi-owned transcript and hook shapes are trusted and imported, not re-modeled

For transcript files and hook events, the package will prefer Pi’s exported types over local copies.

#### Transcript files

`extensions/session-search/extract.ts` currently re-declares many Pi session entry shapes locally and parses JSON lines directly.

The package should instead use Pi’s exported session-file API as the source of truth:

- `SessionHeader`
- `SessionEntry`
- `FileEntry`
- `CustomEntry<T>`
- `SessionInfoEntry`
- `BranchSummaryEntry<T>`
- `CompactionEntry<T>`
- `parseSessionEntries(...)`

This keeps `pi-sessions` aligned with the upstream session-file contract and reduces schema drift.

We will still keep small local helper guards where needed for sub-structures Pi intentionally leaves broad, such as tool-call content blocks or extension-specific `details` payloads.

#### Hook events

`extensions/session-search/hooks.ts` should stop depending on ad hoc narrowing when Pi already publishes event unions and guards.

Use Pi exports such as:

- `ToolCallEvent`
- `ToolResultEvent`
- `ReadToolCallEvent`
- `EditToolCallEvent`
- `WriteToolCallEvent`
- `isToolCallEventType(...)`
- built-in tool-result guards where helpful

This preserves trust in Pi’s host-side guarantees and removes redundant validation for built-in tool hooks.

### 3. Settings are extension-owned config and should be TypeBox-validated

`extensions/shared/settings.ts` reads extension settings from the global Pi settings object, but the `sessions.*` namespace is outside Pi’s typed `Settings` surface.

That means `sessions.*` is still a package-owned dynamic boundary and should be validated with TypeBox.

The settings schema should be intentionally narrow:

- `sessions.index.dir`
- `sessions.handoff.editor`

Design rules:

- top-level Pi settings remain open; only the `sessions` subtree is validated for this package
- unknown keys under `sessions` should be ignored unless they conflict with a known field
- normalization such as `~` expansion and absolute-path enforcement remains in package logic after schema validation
- defaults remain owned by `pi-sessions`, not by the raw settings file

### 4. Custom session metadata should own a formal TypeBox schema

`pi-sessions` writes durable handoff metadata into a Pi `CustomEntry` with:

- `customType = "pi-sessions.handoff"`
- `data = { origin, goal, nextTask }`

This is a classic extension-owned persisted payload. It should have a single formal schema in `extensions/session-handoff/metadata.ts`, and all readers/writers should share it.

That schema becomes the source of truth for:

- metadata creation before `appendCustomEntry(...)`
- metadata parsing in `session-search/extract.ts`
- any future tooling that reads historical handoff entries

### 5. Structured LLM output should validate through the existing TypeBox tool schema

`extensions/session-handoff/extract.ts` already defines `HANDOFF_EXTRACTION_PARAMETERS` as a TypeBox schema for the internal `create_handoff_context` tool.

The returned tool call should be validated against that existing schema rather than manually reading `toolCall.arguments` as an untyped record.

Preferred approach:

- use the existing TypeBox tool definition as the runtime schema
- validate the model-returned tool-call arguments with package-owned TypeBox parsing
- keep post-validation normalization for trimming, deduping, and truncation rules where the runtime behavior should be looser than strict schema validation

This keeps the request and validation contract in one place without relying on coercive helper behavior.

### 6. SQLite validation should happen on read hydration, not on every write binding

SQLite is dynamic at the read boundary, especially where the code currently relies on `as RowType` casts and JSON string columns.

The package should validate **read hydration** with TypeBox for:

- row objects returned from `.get()` / `.all()`
- JSON columns such as `repo_roots_json`
- metadata table values that are later interpreted as typed data

The package should **not** add redundant runtime validation around every write when the write input is already an internal typed domain object built by package code.

This split keeps the architecture idiomatic:

- internal domain model -> SQL write: typed code path
- SQLite row / JSON value -> domain model: runtime-validated boundary

For hot query paths, precompiled TypeBox validators should be preferred over repeated ad hoc structural checks.

### 7. Explicit `unknown` cross-extension payloads are not automatically validation candidates

If an integration surface exposes `unknown` but both sides of the runtime contract are package-owned and travel through a trusted host boundary, the package does not need to add redundant validation just because the static type is broad.

The policy is:

- validate genuinely untrusted boundaries such as file input, model output, and database hydration
- trust package-owned runtime contracts when the host/SDK side is already the owner of the guarantee
- avoid adding TypeBox wrappers merely because a method signature uses `unknown`

## Edge Cases

### Malformed transcript lines

Pi’s transcript parser already skips malformed JSON lines. `pi-sessions` should preserve that tolerant behavior by using Pi’s parser rather than introducing a stricter package-local parser.

### Historical sessions with missing or malformed handoff metadata

Older or corrupted `custom` entries must not fail indexing. The metadata parser should treat invalid payloads as absent metadata and continue indexing the rest of the session.

### Unknown future Pi transcript fields

Because transcript entry contracts are Pi-owned, `pi-sessions` should avoid strict local schema copies that would become brittle when Pi adds fields.

### Settings drift or invalid path formats

Invalid `sessions.index.dir` values should still fail clearly and early. Unknown unrelated Pi settings should not affect `pi-sessions` behavior.

### SQLite corruption or stale schema drift

If row hydration fails for required session-search reads, the package should fail closed with the existing “rebuild the index” guidance rather than continuing with partially trusted row data.

### Invalid LLM tool-call arguments

If the model emits `create_handoff_context` with wrong argument types, handoff generation should fail explicitly instead of silently assembling a degraded prompt from partial data.

### Powerline version skew

Powerline autocomplete refresh data is treated as a trusted package-owned contract. Version skew should be handled by keeping the shared contract aligned across repos rather than adding defensive validation in `pi-sessions`.

## Rejected Alternatives

### 1. Add Zod alongside TypeBox

Rejected because the package already uses TypeBox and Pi itself is TypeBox-oriented at the tool/schema layer. A second schema system would increase surface area without solving a problem the existing stack cannot solve.

### 2. Re-validate all trusted Pi/provider SDK contracts locally

Rejected because it adds noise and maintenance cost while weakening the architectural boundary definition. If Pi or the provider SDK is the owner of a runtime contract and already guarantees the type, `pi-sessions` should consume that contract directly.

### 3. Define a full package-local transcript schema for Pi session files

Rejected because Pi already publishes transcript/session types and parsers. A local duplicate schema would be more brittle than importing Pi’s own contract and would create avoidable drift.

## Integration Points

### `extensions/shared/settings.ts`

Add TypeBox-backed parsing for the `sessions` namespace while preserving existing defaults and normalization rules. Keep a clear split between file-backed config and resolved runtime settings.

### `extensions/session-handoff/metadata.ts`

Promote handoff metadata from a plain interface helper to a shared schema + creator + parser module.

### `extensions/session-handoff/extract.ts`

Use the existing TypeBox tool schema to validate model-returned `create_handoff_context` tool calls.

### `extensions/session-search/extract.ts`

Replace local transcript shadow types with Pi imports and route custom handoff metadata through the shared metadata parser.

### `extensions/session-search/hooks.ts`

Use Pi’s event unions and narrowing helpers for built-in tool hooks.

### `extensions/session-search/db.ts`

Introduce typed row-hydration helpers and validated JSON-column parsing for database reads.

### `extensions/session-handoff/autocomplete.ts`

Continue treating Powerline refresh payloads as a trusted package-owned contract unless that integration becomes versioned or independently owned.

## Testing Strategy

The design should be covered by focused tests at each boundary:

- settings parsing tests for defaults, valid overrides, and invalid overrides
- metadata round-trip tests for create + parse behavior
- handoff extraction tests for valid and invalid model-returned tool calls
- DB hydration tests for valid rows, malformed JSON columns, and rebuild-required failure cases
- extract/hook tests to confirm Pi exported transcript/event types still support current indexing behavior
- no autocomplete payload validation tests are required while Powerline refresh data remains a trusted package-owned contract

## Implementation Plan

- [ ] Add a small shared TypeBox validation helper module for package-owned schemas, including a consistent way to check/parse values and format failures.
- [ ] Update `extensions/shared/settings.ts` to define a TypeBox schema for the `sessions` namespace and derive file-backed settings from the validated result instead of manual field walking.
- [ ] Keep path normalization in `extensions/shared/settings.ts`, but run it only after the `sessions` subtree has passed schema validation and then resolve ergonomic runtime settings from that file-backed shape.
- [ ] Expand `extensions/session-handoff/metadata.ts` to define the canonical TypeBox schema for `pi-sessions.handoff` payloads and export both creation and parsing helpers.
- [ ] Update `extensions/session-handoff.ts` to continue writing handoff metadata through the shared metadata module without changing the persisted `customType` contract.
- [ ] Update `extensions/session-handoff/extract.ts` to validate the `create_handoff_context` tool-call arguments with package-owned TypeBox parsing instead of manually consuming `toolCall.arguments`.
- [ ] Replace local session transcript interfaces in `extensions/session-search/extract.ts` with Pi-exported session types and Pi’s transcript parser, keeping only the minimal local guards needed for broad sub-structures such as message-content blocks.
- [ ] Route custom-entry metadata parsing in `extensions/session-search/extract.ts` through the shared handoff metadata parser so indexing and future readers use the same contract.
- [ ] Update `extensions/session-search/hooks.ts` to use Pi’s built-in hook event types and narrowing helpers for `read`, `edit`, and `write` tool calls/results.
- [ ] Introduce row-hydration helpers in `extensions/session-search/db.ts` for the major query row types currently read via `as SomeRow`, and validate JSON columns such as `repo_roots_json` before turning them into domain values.
- [ ] Preserve typed internal write helpers such as `sessionRowBindings(...)`; do not add redundant runtime validation to every write path.
- [ ] Keep Powerline refresh payload handling unchanged unless that integration ceases to be a trusted package-owned contract.
- [ ] Add or update tests in `test/session-search.settings.test.ts`, `test/session-handoff.settings.test.ts`, `test/session-handoff.command.test.ts`, `test/session-search.extract.test.ts`, `test/session-search.hooks.test.ts`, and `test/session-search.db.test.ts` to cover the new validation boundaries and Pi-type alignment.
- [ ] Update `README.md` only if the external configuration contract or failure behavior becomes user-visible.
