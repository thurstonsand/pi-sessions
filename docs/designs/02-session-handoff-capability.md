# Session Handoff Capability Plan

## Context

`session_search` and `session_ask` solve discovery and recall across prior Pi work. They do not solve the other half of long-running work: deliberately moving a live conversation into a fresh session without losing the thread.

We want a first-party handoff flow inside `pi-sessions` that:

- creates a new session with curated context rather than relying only on compaction
- preserves clean UX during the session switch
- stays compatible with normal Pi compaction instead of replacing it
- integrates with the package's session recall features where that improves ergonomics
- leaves room for lineage-aware references such as `@handoff/...`

This design is a follow-up to `01-session-search-capability.md`. The search/ask package should also own handoff so the full session lifecycle lives in one place.

## Problem Statement

Pi's built-in session controls and existing third-party handoff implementations leave three gaps for this package:

1. **Context transfer quality**: freeform summarization is convenient, but inconsistent. We want structured extraction so the generated handoff draft is predictable.
2. **UX quality**: low-level tool-path session switches can make a new session look like a continuation of the old one. That is confusing. We want a clean, visible session reset.
3. **Session continuity**: once handoff creates parent/child session relationships, the same package should be able to reason about that lineage for recall, references, and future ergonomics.

## Approach

### V1 scope

Keep v1 narrow and clean:

- provide a human-facing `/handoff <goal>` command
- add optional split flags: `/handoff --left|--right|--up|--down <goal>`
- keep handoff **command-only** in v1; do **not** expose an LLM-callable `handoff` tool yet
- use structured extraction with an internal, handoff-scoped tool schema
- show a review gate before sending
- if the user does nothing for 8 seconds, auto-send the generated draft as-is
- use the same prepared-child model for both in-process and split-pane handoff
- create child session files explicitly with a native session header containing `parentSession`, but no pre-seeded metadata or prompt messages
- activate in-process handoffs by switching into the prepared child session
- activate split-pane handoffs by launching a fresh `pi` instance in Ghostty while leaving the current session active
- pass handoff bootstrap payload via an ephemeral environment variable keyed to the target child session id
- pass the child's full session UUID to `pi --session`, not the full path
- default split-pane launch focus to the original pane
- start spawned child sessions with default model / thinking / tools for now
- preserve normal Pi compaction behavior; handoff is complementary, not a replacement
- persist parent-session lineage in the sidecar index so recall and later ergonomics can build on it
- ship a small, handoff-only `@handoff/...` autocomplete path in the prompt editor

V1 does **not** include:

- proactive threshold-triggered handoff generation
- `session_before_compact` cancellation or compaction replacement
- fork-based handoff or copied conversation history in the child session
- inherited or user-configurable launch model / thinking / tools for the spawned child session
- pane-title customization for spawned Ghostty surfaces
- persistent bootstrap transport files when env transport is sufficient
- nonce / ack entries for startup handoff delivery
- a tool-path handoff that auto-switches after an agent turn
- a full lineage-navigation tool surface
- a generalized mention framework for other token families

### Core UX flow

The handoff command should behave like this:

1. user runs `/handoff <goal>` or `/handoff --left|--right|--up|--down <goal>`
2. extension serializes the current conversation branch
3. the current model, or an optional handoff-model override if configured, receives the conversation, the goal, and a handoff-only extraction tool
4. the extension assembles a deterministic draft prompt from the structured result
5. the extension shows a lightweight review overlay with:
   - a preview of the draft
   - a visible 8-second countdown
   - `Enter` to open full editing
   - `Esc` to cancel
6. if the user does nothing, the draft is accepted automatically
7. if the user presses `Enter`, the extension opens `ctx.ui.editor(...)` for full review/edit
8. once accepted, the extension creates a prepared child session containing only a native session header with `parentSession`
9. the extension packages the approved handoff payload into `PI_SESSIONS_HANDOFF_BOOTSTRAP` as base64-encoded JSON, including the target child session id
10. the child session is activated:
   - plain `/handoff <goal>` switches into the prepared child session in-process
   - split-pane handoff calls `ghostty-nav split <direction> --focus original ...` to launch a fresh `pi --session <full-uuid>` in the new pane
11. on child-session start, the extension consumes the bootstrap env var, validates that the target session is still fresh, appends durable handoff metadata, and sends the approved handoff prompt as the first user message

This keeps the current session alive when the user asks for a background handoff, while still making the new session visibly real rather than pretending the old UI simply continued.

### Review model

The countdown belongs in the **preview gate**, not the full editor.

Reasoning:

- `ctx.ui.editor(...)` is the correct primitive for real editing
- once the user intentionally enters the editor, auto-send should stop; editing is now explicit
- the preview gate keeps the default path fast while preserving a real review escape hatch

So the rules are:

- idle in preview for 8 seconds → auto-send
- `Enter` in preview → open editor, no timer
- `Esc` in preview or editor → cancel immediately; nothing is sent
- after editing, submission is explicit

### Structured extraction, not freeform prompt writing

Use the `bdsqqq/dots` approach as the architectural reference.

The extraction model should not write the final prompt freeform. Instead, it should be forced to call an internal tool available **only** during handoff generation.

Proposed internal extraction tool:

```ts
create_handoff_context({
  summary: string,
  relevantFiles: string[],
  nextTask: string,
  openQuestions?: string[]
})
```

Properties:

- `summary` — only the transfer context relevant to the next task; omit background that will not help the receiving session
- `relevantFiles` — workspace-relative paths when possible
- `nextTask` — the concrete thing the new session should do
- `openQuestions` — optional unresolved items that matter to the next thread

This tool is **not** registered as a normal Pi tool. It exists only inside the internal `complete(...)` call used to generate a handoff draft.

### Draft assembly

The final prompt should be assembled in code, not trusted to the extraction model.

Recommended draft shape:

```md
Continuing work from session <canonical reference>. When you lack specific information you can use `session_ask` to get it.

## Task
<nextTask or user goal>

## Relevant Files
- path/to/file
- path/to/other

## Context
<summary>

## Open Questions
- ...
```

Assembly rules:

- the bare continuity line comes first
- `Task` comes immediately after it
- `Relevant Files` comes before `Context`
- omit empty sections rather than rendering placeholders
- include a stable parent-session reference in the opening line
- keep the handoff prompt concise enough to be a good first message, not a second transcript

### Session switching model

All actual handoff orchestration should still go through `ExtensionCommandContext`, but both launch paths now share the same prepared-child model.

For both in-process and split-pane handoff:

1. write a minimal child session file explicitly into the current session directory
2. include only a native session header with `parentSession`
3. do **not** pre-seed durable handoff metadata or the first user prompt into the child session file
4. package the approved handoff payload into `PI_SESSIONS_HANDOFF_BOOTSTRAP` as base64-encoded JSON with `sessionId`, `goal`, `nextTask`, and `initialPrompt`

Then activate the child session by one of two mechanisms:

- in-process handoff: `ctx.switchSession(childSessionFile)`
- split-pane handoff: launch `pi --session <full-session-uuid>` in a new Ghostty split via `ghostty-nav`

Use the full session UUID rather than the full file path when launching the child process. That keeps the external launch interface cleaner and doubles as a sanity check that the child was written to the expected session directory.

On `session_start`, the extension should:

1. read the bootstrap env payload
2. ignore it unless the target session id matches the current session id
3. scan current session entries
4. if any user message already exists, abort bootstrap, show `Session handoff failed: target session already has user input.`, and do not append handoff metadata
5. if no user message exists and no handoff metadata exists yet, append the durable `pi-sessions.handoff` metadata
6. if metadata already exists but there is still no user message, skip the append and still send the approved prompt as the first user message
7. clear the bootstrap env payload after the matching child consumes it

Do **not** use `SessionManager.create()` or `sessionManager.newSession()` alone for the split-pane path. A blank new session is not flushed to disk until an assistant message exists, so a second `pi` process would have nothing stable to open yet.

Do **not** use `pi --fork` for handoff. Fork copies prior conversation history, while handoff should always start from a fresh child session plus the approved handoff prompt.

Do **not** implement the low-level `sessionManager.newSession()` + `context` filtering pattern used in the `pi-amplike` tool path. It works around API limitations, but produces confusing UX and creates two realities:

- the model sees a fresh session
- the user sees apparent continuity

That split is specifically what this design avoids.

### Recall integration

This package owns both handoff and recall, so the integration should be deliberate.

Resolved decision:

- handoff and recall remain separate modules, but they should share a common session-reference layer

Concretely:

- handoff stores `parentSession` in the native Pi session header
- the sidecar index stores enough lineage metadata to resolve parent/child relationships
- `session_ask` should accept a more ergonomic session reference, not only an absolute path

Today `session_ask` takes a file path. The evolution here is to keep that working, but add a single resolver path for more human-usable references.

Recommended `session_ask` evolution:

```ts
session_ask({
  session: string, // absolute path, raw session id, or canonical handoff ref
  question: string
})
```

The public form should just be `session`.

- normalize all accepted reference styles through the same resolver path
- do not keep a parallel `sessionPath` parameter

### Canonical handoff references and editor autocomplete

Use a canonical handoff reference format:

```text
@handoff/<session-id-prefix>
```

That gives us:

- cleaner prompts than raw absolute paths
- a stable thing the user can type or paste
- a first-class bridge between handoff creation and session recall
- prompt-editor autocomplete for known lineage-linked sessions

Resolved decision:

- this package should ship a **handoff-only** mention/autocomplete path
- it should **not** build a generalized mention framework in v1

Concretely, v1 should add a narrow slice of infrastructure just for `@handoff/...`:

1. detect when the prompt cursor is inside an `@handoff/` prefix
2. query indexed lineage-linked sessions from the sidecar DB
3. return autocomplete suggestions using canonical handoff refs plus a human-friendly label
4. replace the typed prefix with the chosen `@handoff/<id>` token
5. rewrite canonical handoff tokens to raw session UUIDs before model execution so `session_ask` can stay UUID-only

This is intentionally smaller than the `bdsqqq/dots` architecture. We want the ergonomics of `@handoff` now, without taking on a full multi-kind mention system.

### Handoff-only autocomplete infrastructure

The local autocomplete path should be minimal and package-owned.

Recommended pieces:

- `extensions/session-handoff/autocomplete.ts`
  - prompt-prefix detection for `@handoff/`
  - suggestion formatting and completion application
- `extensions/session-handoff/query.ts`
  - DB queries for lineage-linked sessions by prefix, recency, relation, and optional cwd affinity
- `extensions/session-handoff/refs.ts`
  - canonical formatting and resolution helpers shared with `session_ask`
- `extensions/session-handoff.ts`
  - registration glue that adapts the same prompt-editor autocomplete integration pattern already proven in `dots`

Behavioral goals:

- autocomplete suggestions should prefer recent lineage-linked sessions
- suggestions should show a human-friendly label: session title when present, otherwise the first user message
- if the UI supports it, show relation metadata such as parent, child, sibling, or fork in the suggestion description
- selecting a suggestion should insert only the canonical token, not hidden context
- hidden context injection is out of scope for this package's first handoff implementation

This is a deliberate non-goal difference from `bdsqqq/dots`, where the mention system also resolves tokens into turn-local hidden context blocks.

### Lineage model

The session graph should be modeled explicitly enough to support later ergonomics.

At minimum, index and expose:

- `parentSessionPath`
- derived `parentSessionId`
- `sessionOrigin` (`handoff`, `fork`, or `unknown_child`)

From those fields, helper queries can derive:

- parent
- ancestors
- children
- siblings

Important behavior:

- multi-hop lineage chains are recursive by following parent links upward
- sibling sessions are discoverable by querying sessions with the same parent
- autocomplete should be lineage-aware: parent, children, siblings, ancestors, and forked descendants can all surface when relevant
- compactions do not create new sessions; they stay inside the same session file, so they are not separate `@handoff/...` targets
- v1 does not need a dedicated public lineage tool, but the data model should not block one later

### Database changes

Extend the `sessions` table with lineage metadata:

- `parent_session_path TEXT`
- `parent_session_id TEXT`
- `session_origin TEXT` — `handoff`, `fork`, `unknown_child`, or `NULL` for roots

Update extraction and hook sync so these fields are populated during both:

- full reindex
- future hook-maintained updates

Notes:

- `parent_session_id` captures topology: this session came from another session
- `session_origin` captures intent for ranking and display: was this child created by `/handoff`, by `/fork`, or discovered later without a stronger origin marker?
- full reindex should infer `unknown_child` whenever a parent exists but no stronger origin signal is available
- live hook updates can record `handoff` and `fork` precisely at creation time

This keeps handoff lineage visible to the same sidecar index that already powers search and recall.

### Model selection

Working assumption for v1:

- default to the currently active model for extraction
- support an optional handoff-model override in package config

Reasoning:

- zero-config behavior stays simple
- users who care can pin a different extraction model explicitly
- the structured tool contract already stabilizes output quality significantly

## Design Decisions

### 1. Command-only first

Start with `/handoff` only, with optional split flags.

Why:

- command handlers can safely own generation and review UX
- both in-process and split-pane handoff can share one prepared-child bootstrap model
- activation can differ while the resulting child-session state stays largely aligned

A future LLM-callable handoff tool is possible, but not in v1. The split-pane launch model makes that future cleaner than before, but it is still a separate product decision and should come only after the command path is solid.

### 2. Keep compaction and handoff separate

Do not disable compaction.

Why:

- you explicitly want both tools available
- handoff is deliberate context transfer, not mandatory overflow management
- compaction should remain Pi's default pressure release valve unless the user invokes handoff intentionally

### 3. Structured extraction wins over freeform generation

Use an internal extraction tool with a fixed schema.

Why:

- deterministic output shape
- easier validation and truncation
- more reliable file capture
- cleaner integration with later recall and lineage features

### 4. Code assembles the final draft

The model extracts. The extension composes.

Why:

- keeps prompt shape stable
- reduces formatting drift between handoffs
- makes later UX tweaks cheap

### 5. Review gate before launch

Use a preview-and-countdown layer before any new-session launch.

Why:

- gives the human a chance to intervene
- still keeps the no-input path fast
- avoids forcing everyone through a full edit step

### 6. Both handoff modes use a prepared child session file

For both in-process and separate-instance handoff, create the child JSONL file directly instead of relying on Pi to create it implicitly.

Why:

- native `parentSession` lineage must exist in the child session header before activation
- `ctx.newSession(...)` tears down the current runtime, which defeats the goal of keeping the parent session alive for split-pane handoff
- a prepared child file lets both launch modes converge on the same session shape

### 7. Bootstrap handoff state via env payload, not pre-seeded entries

Use an ephemeral env payload keyed by child session id, and let the child materialize metadata and the first prompt on startup.

Why:

- avoids duplicating root custom entries when Pi bulk-flushes a prepared session
- keeps the child session file minimal before activation
- lets both in-process and forked handoff share the same startup materialization logic

### 8. Launch spawned children by full session UUID

Use `pi --session <full-uuid>`, not the full JSONL path.

Why:

- cleaner external command surface
- validates that the child session was written into the expected session directory
- avoids coupling the launcher to absolute session-file paths

### 9. Default split focus stays on the original pane

Background handoff should leave the user's current pane focused.

Why:

- the feature's purpose is to spin work up elsewhere without interrupting the current flow
- `ghostty-nav` already exposes explicit focus control, so the behavior is easy to make deterministic
- focus-jumping can always be added later if it proves useful

### 10. Spawned child sessions start with defaults for now

Do not inherit current model / thinking / tools in the first version of split-pane handoff.

Why:

- it keeps the first implementation simpler
- default launch behavior matches normal `pi` startup
- inheritance and per-handoff overrides can be added later once the core launch path is stable

### 11. Lineage belongs in the index

Persist parent metadata in the sidecar DB.

Why:

- search, recall, and handoff should not each rescan raw session files independently
- lineage-aware features become cheap once the metadata is indexed
- siblings and ancestor chains can be derived consistently

### 12. Build a narrow handoff-only autocomplete path

Ship `@handoff/...` autocomplete in v1, but keep it local to handoff.

Why:

- you explicitly want the ergonomics now
- the package already owns the session index needed to power suggestions
- a handoff-only slice is much smaller than a generic mention framework
- we can reuse the shape of the `dots` solution without importing its full abstraction stack

## Edge Cases

- **No interactive UI**: `/handoff` should fail clearly in non-interactive mode.
- **No active model / API key**: fail before generation starts.
- **Empty or nearly empty conversation**: refuse handoff; there is nothing meaningful to transfer.
- **Extraction returns malformed output**: show an error and do not launch anything.
- **Extraction returns no files**: omit the files section; do not invent paths.
- **Preview timer expires while the user is idle**: accept the generated draft and proceed.
- **User presses `Enter` near timer expiry**: entering the editor wins; the timer is cancelled.
- **User cancels in preview or editor**: stay in the current session and discard the pending handoff draft.
- **Prepared in-process child fails to switch**: remain in the old session; do not materialize bootstrap state in the child.
- **Split-pane handoff is requested outside Ghostty**: fail clearly and do not create or launch a child session.
- **`ghostty-nav` is unavailable**: fail clearly and do not create or launch a child session.
- **Child session file is created but Ghostty or `pi` launch fails**: keep the child session on disk, notify the user with its full UUID, and let them start it manually later.
- **Bootstrap payload targets a different session id**: ignore it.
- **Bootstrap reaches a child session that already has any user message**: show a UI notification that the target session is no longer fresh, and do not append handoff metadata.
- **Bootstrap reaches a child session where handoff metadata already exists but no user message exists yet**: skip metadata append and still send the initial prompt.
- **Split-pane handoff accidentally reuses fork semantics**: reject the implementation; handoff children must never contain copied conversation history.
- **Session-id resolution is ambiguous**: always pass the child's full UUID, not a short prefix.
- **Multiple handoffs from the same source session**: each child stores the same parent; later sibling lookup should work by shared parent.
- **Recursive handoffs**: each child stores only its immediate parent; ancestor traversal walks recursively.
- **Compaction after a handoff**: normal Pi behavior applies; handoff does not alter compaction hooks.
- **Canonical handoff ref cannot be resolved**: `session_ask` should fail clearly and tell the user what kind of ref it expected.

## Rejected Alternatives

Only alternatives discussed so far are listed here.

### Using `ctx.newSession(...)` for split-pane handoff

Rejected.

Reason:

- Pi tears down the current runtime when creating the new session
- that defeats the core goal of keeping the original session alive while the child starts elsewhere

### Pre-seeding handoff metadata or the first prompt into the child session file

Rejected.

Reason:

- Pi can bulk-flush prepared sessions on first assistant output
- duplicated root custom entries cause the rendered session tree to replay the initial branch twice
- header-only preparation plus startup materialization is a cleaner compromise

### Using `SessionManager.create()` / `newSession()` alone for split-pane handoff

Rejected.

Reason:

- a blank new session is not flushed to disk early enough for a second `pi` process to open it reliably
- relying on private persistence internals would make the feature brittle

### Using `pi --fork` for handoff

Rejected.

Reason:

- fork copies prior conversation history into the child session
- handoff should always start from a fresh child session plus the approved prompt

### Low-level tool-path handoff in v1

Rejected for v1.

Reason:

- even with the better separate-instance launch model, the first version should keep orchestration and review policy in an explicit user command
- command-only keeps the initial behavior easier to reason about and test

### LLM-callable `handoff` tool in v1

Rejected for v1.

Reason:

- the basic command-path experience should be proven first
- the tool version intentionally wants different UX semantics: no review gate, no countdown, automatic background launch
- that is a follow-up feature, not part of the first split-pane command rollout

### Proactive threshold-triggered handoff

Rejected.

Reason:

- you want handoff and compaction to coexist
- auto-triggered handoff is unnecessary policy here
- deliberate invocation is the preferred control model

### Freeform prompt generation

Rejected.

Reason:

- too much output variance
- harder to validate and normalize
- weaker foundation for later lineage-aware features

### Generalized multi-kind mention framework in v1

Rejected.

Reason:

- unnecessary scope for the first implementation
- `@handoff/...` is the only immediate ergonomic need
- a local handoff-only path gets most of the value with much less surface area

## Integration Points

### Existing package components

- `extensions/session-ask.ts`
  - should resolve canonical handoff refs, raw session ids, and absolute session paths
- `extensions/session-search/db.ts`
  - needs lineage columns and helper queries
  - should also expose a narrow query for autocomplete-friendly lineage candidates
- `extensions/session-search/extract.ts`
  - already parses `parentSession`; extend the extracted record surface to carry it through indexing
- `extensions/session-search/reindex.ts`
  - persist lineage metadata during rebuild
- `extensions/session-search/hooks.ts`
  - keep lineage metadata fresh during hook-driven sync

### New components

- `extensions/session-handoff.ts`
  - `/handoff` command entry point and orchestration
  - split-flag parsing and launch-path selection
  - shared startup-bootstrap consumption logic
  - registration glue for handoff-only autocomplete
- `extensions/session-handoff/extract.ts`
  - extraction prompt, internal tool schema, and draft assembly
- `extensions/session-handoff/review.ts`
  - preview gate with countdown and editor handoff
- `extensions/session-handoff/spawn.ts`
  - header-only child-session file creation
  - bootstrap env payload assembly
  - Ghostty / `ghostty-nav` validation and launch-command assembly
- `extensions/session-handoff/refs.ts`
  - canonical ref formatting and resolution helpers
- `extensions/session-handoff/lineage.ts`
  - internal parent/ancestor/child/sibling queries over indexed data
- `extensions/session-handoff/autocomplete.ts`
  - handoff-only prompt prefix detection, suggestions, and completion application
- `extensions/session-handoff/query.ts`
  - indexed lookup helpers for lineage-linked autocomplete candidates and suggestion ranking

### Package documentation

- `README.md`
  - add handoff workflow, countdown behavior, split-pane launch notes, and recall integration notes

## Files to Modify

### New files

- `extensions/session-handoff/spawn.ts`
  - validate Ghostty / `ghostty-nav` preconditions for handoff activation
  - create header-only child session files explicitly
  - assemble session-targeted bootstrap env payloads
  - assemble and launch the `ghostty-nav split ... pi --session <full-uuid>` command
- `test/session-handoff.spawn.test.ts`
  - cover child-session file creation, bootstrap-payload shaping, Ghostty validation, and launch-command shaping

### Modified files

- `README.md`
  - document `/handoff`
  - document optional `--left|--right|--up|--down` launch flags
  - document Ghostty / `ghostty-nav` requirements for split-pane handoff
- `extensions/session-handoff.ts`
  - extend command parsing for split flags
  - prepare header-only child sessions
  - switch in-process handoff into prepared children
  - choose between in-process and split-pane activation paths
  - consume startup bootstrap payloads on session start
- `extensions/session-handoff/extract.ts`
  - continue to define `create_handoff_context`
  - continue to call `complete(...)` with the handoff-only tool
  - continue to validate extraction output and assemble the final draft
- `extensions/session-handoff/review.ts`
  - keep preview/countdown UI shared across both launch paths
- `extensions/session-ask.ts`
  - accept resolved handoff/session references instead of only absolute session paths
- `extensions/session-search/db.ts`
  - bump schema version
  - extend `SessionRow`
  - extend schema and `insertSession` / `upsertSession`
  - add lineage lookup helpers
- `extensions/session-search/extract.ts`
  - carry `parentSessionPath` / `parentSessionId` / `sessionOrigin` in `ExtractedSessionRecord`
- `extensions/session-search/reindex.ts`
  - persist new lineage fields
- `extensions/session-search/hooks.ts`
  - preserve lineage fields during hook sync

## Implementation Plan

### Phase 1 — unified prepared-child handoff core

Deliverable: `/handoff <goal>` and `/handoff --left|--right|--up|--down <goal>` share the same prepared-child bootstrap model. The plain command switches into the prepared child in-process, while split-pane handoff launches that same child in Ghostty and leaves the parent session active.

- [ ] Extend `extensions/session-handoff.ts` to parse optional split flags
- [ ] Keep the existing structured extraction flow and validate the internal `create_handoff_context` tool schema
- [ ] Keep assembling the final handoff draft in code
- [ ] Keep the 8-second preview countdown with `Enter` → edit and `Esc` → cancel
- [ ] Add `extensions/session-handoff/spawn.ts`
- [ ] Implement explicit header-only child-session file creation
- [ ] Implement session-targeted bootstrap env payload creation
- [ ] Switch in-process handoff into the prepared child session
- [ ] Launch split-pane handoff with `ghostty-nav split <direction> --focus original ...`
- [ ] Pass the full child UUID to `pi --session`
- [ ] Materialize durable handoff metadata on child `session_start`
- [ ] Abort startup bootstrap if the target child already has a user message, and show a UI notification that the session is no longer fresh
- [ ] Fail clearly when not in Ghostty or when `ghostty-nav` is unavailable
- [ ] Surface split-pane launch failures while preserving the created child-session UUID for manual recovery
- [ ] Ensure handoff never copies full session history
- [ ] Add tests for extraction success/failure, countdown behavior, cancel behavior, child-session creation, bootstrap consumption, in-process switching, Ghostty launch shaping, and recovery on launch failure

### Phase 2 — lineage persistence + recall integration

Deliverable: lineage-linked parent/child relationships are indexed and recall tools can resolve canonical refs.

- [ ] Bump the index schema version
- [ ] Add `parent_session_path`, `parent_session_id`, and `session_origin` to indexed session metadata
- [ ] Extend full reindex to persist lineage fields and infer `unknown_child` where needed
- [ ] Extend hook sync to keep lineage fields current and record `handoff` vs `fork` when known
- [ ] Add `extensions/session-handoff/refs.ts`
- [ ] Update `session_ask` to resolve absolute paths, raw session ids, and canonical handoff refs
- [ ] Add lineage helper queries for parent, ancestors, children, and siblings
- [ ] Add tests for recursive parent walking and sibling discovery

### Phase 3 — handoff-only autocomplete

Deliverable: `@handoff/<uuid-prefix>` autocompletes in the prompt editor and stays visible to the model as a session token.

- [ ] Add `extensions/session-handoff/autocomplete.ts`
- [ ] Add `extensions/session-handoff/query.ts`
- [ ] Wire a handoff-only autocomplete contributor into the prompt editor
- [ ] Detect `@handoff/` prefixes without introducing a generalized mention parser
- [ ] Return recent lineage-linked sessions with human-friendly labels
- [ ] Add a power-user override such as `Ctrl+A` in the autocomplete window to show all sessions, not only the current lineage tree
- [ ] Apply selected completions as canonical `@handoff/<id>` tokens
- [ ] Add tests for prefix detection, suggestion ranking, and completion replacement

### Phase 4 — documentation and verification polish

Deliverable: the package exposes a coherent handoff/recall workflow and is documented well.

- [ ] Document `/handoff`, the review/countdown flow, and optional split flags in `README.md`
- [ ] Document Ghostty / `ghostty-nav` requirements and failure behavior for split-pane handoff
- [ ] Document how handoff references interact with `session_ask`
- [ ] Document `@handoff/...` autocomplete behavior and fallback typed-reference behavior
- [ ] Add final smoke-test instructions covering split-pane handoff → child session start → `@handoff` autocomplete → session_ask on the parent

## Verification

### Automated coverage

- unit tests for extraction-tool parsing and draft assembly
- unit tests for handoff-ref formatting and resolution
- unit tests for `@handoff/` prefix detection and completion replacement
- integration tests for preview countdown transitions
- integration tests for DB schema upgrades and lineage persistence
- integration tests for `session_ask` reference resolution
- integration tests for lineage-aware autocomplete queries
- strict `tsc --noEmit`
- Biome formatting/lint checks
- Vitest suite

### Smoke test — handoff core

- open Pi with the package loaded in Ghostty
- do enough work to make handoff meaningful
- run `/handoff <goal>`
- confirm the preview overlay appears with an 8-second countdown
- confirm idle timeout switches into a visibly new prepared child session in-process
- inspect the child JSONL and confirm it starts header-only with native `parentSession`
- confirm the child receives the approved handoff prompt exactly once on startup via `PI_SESSIONS_HANDOFF_BOOTSTRAP`
- repeat with `/handoff --right <goal>`
- confirm idle timeout launches that same prepared-child model in the right split
- confirm the launched command uses `pi --session <full-uuid>` plus `PI_SESSIONS_HANDOFF_BOOTSTRAP`
- confirm the original pane keeps focus
- repeat and press `Enter` to edit instead
- cancel once from preview and once from editor to confirm the old session remains untouched
- simulate a stale child session with an existing user message and confirm the UI shows `Session handoff failed: target session already has user input.`
- simulate a split-pane launch failure and confirm the parent session reports the created child UUID plus a bootstrap-aware manual resume command

### Smoke test — recall integration

- complete a handoff into a new session
- confirm the new session stores `parentSession`
- confirm handoff metadata is appended on child startup, not pre-seeded into the child file
- type `@handoff/` in the prompt editor and confirm handoff suggestions appear
- select the parent-session suggestion and confirm the canonical token is inserted
- run `session_ask` against the parent by canonical ref or session id
- confirm the answer comes from the parent session tree
- create two child handoffs from the same parent and confirm sibling lookup helpers identify both children

## Reuse

Existing references to reuse:

- prior package design
  - `/Users/thurstonsand/Develop/pi-sessions/docs/designs/01-session-search-capability.md`
- current package session parsing and indexing
  - `/Users/thurstonsand/Develop/pi-sessions/extensions/session-search/extract.ts`
  - `/Users/thurstonsand/Develop/pi-sessions/extensions/session-search/db.ts`
  - `/Users/thurstonsand/Develop/pi-sessions/extensions/session-search/reindex.ts`
  - `/Users/thurstonsand/Develop/pi-sessions/extensions/session-search/hooks.ts`
- existing recall tool
  - `/Users/thurstonsand/Develop/pi-sessions/extensions/session-ask.ts`
- Pi extension/session APIs
  - `/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/docs/extensions.md`
  - `/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/docs/session.md`
- upstream handoff references
  - `https://github.com/pasky/pi-amplike/blob/main/extensions/handoff.ts`
  - `https://github.com/hjanuschka/shitty-extensions/blob/main/extensions/handoff.ts`
  - `https://github.com/bdsqqq/dots/blob/main/user/pi/packages/extensions/handoff/index.ts`
  - `https://github.com/bdsqqq/dots/blob/main/user/pi/packages/extensions/handoff/handoff-mention-source.ts`
- upstream mention/autocomplete references to relocate later if needed
  - repo root: `https://github.com/bdsqqq/dots/tree/main/user/pi`
  - prompt-editor wiring: `https://github.com/bdsqqq/dots/blob/main/user/pi/packages/extensions/mentions/index.ts`
  - mention-aware autocomplete provider: `https://github.com/bdsqqq/dots/blob/main/user/pi/packages/core/mentions/provider.ts`
  - mention source registry: `https://github.com/bdsqqq/dots/blob/main/user/pi/packages/core/mentions/sources.ts`
  - mention prefix parser: `https://github.com/bdsqqq/dots/blob/main/user/pi/packages/core/mentions/parse.ts`

## Notes

Two implementation choices are intentionally deferred until the core flow exists:

1. whether to add an LLM-callable `handoff` tool later
2. whether the handoff-only autocomplete should eventually be promoted into a generalized session-mention framework

Neither is required to make the first handoff design correct.