# 05 — Session auto-titling plan

## Context

`pi-sessions` already owns session-oriented UX in this package:

- indexed historical recall via `session_search`
- deep follow-up via `session_ask`
- deliberate thread creation via `/handoff`
- hook-driven session lifecycle wiring in `extensions/session-hooks.ts`

Pi already exposes the core primitive needed for naming:

- `pi.setSessionName(name)` sets the persisted session display name
- session names are stored as `session_info` entries and already flow into this package’s index/extraction paths

That means auto-titling does not need a new storage primitive for the title itself. It needs:

1. a policy for **when** to generate a name
2. a compact, robust way to build **naming context** from the current session
3. a durable way to remember **auto-title state** so reloads and resumes do not cause duplicate or unwanted renames
4. a manual command to **re-run** titling on demand

Two existing extensions are useful reference points:

- `HazAT/pi-smart-sessions`
  - very small, one-shot naming flow
  - uses early-session input as the naming seed
  - applies a fallback title immediately, then lets an LLM refine it
- `default-anton/pi-tmux-window-name`
  - broader naming subsystem
  - includes manual rename command, in-flight guards, parsing/normalization, restore behavior, and stale-update protection

The best fit here is to combine those ideas:

- keep the trigger model simple like `pi-smart-sessions`
- adopt the durability, guards, and manual control ideas from `pi-tmux-window-name`

## Problem Statement

We want sessions to acquire and maintain useful titles automatically, without fighting the user.

Desired behavior:

1. a new session gets an early title from its first real prompt
2. the title can be refreshed every N turns based on the latest session state
3. the user can manually trigger a refresh at any time
4. manual naming by the user should win over automation
5. restarts, reloads, switches, and forks should not cause duplicate or stale renames

## Goals

- add automatic session naming for the current session
- support a fast initial title for unnamed sessions
- support periodic title refreshes based on updated context
- support an explicit command to recompute the title now
- pause automation when the user manually changes the session name
- keep implementation local to this package and consistent with existing extension patterns
- keep token/cost footprint low

## Non-Goals

- renaming historical sessions in bulk
- using the full `session_search` index as the primary titling source
- building a generalized “auto metadata” framework in v1
- replacing Pi’s built-in `/name` UX
- synchronizing tmux/window/tab titles in v1

## UX Contract

### Default behavior

For an unnamed session:

1. after the first substantive user prompt, the extension generates an initial title
2. after every configured refresh interval, it may generate an updated title
3. if the generated title is effectively unchanged, nothing happens

### Manual behavior

Add a command such as:

- `/retitle` — recompute the title from the current session state

Optional v2 command surface:

- `/retitle status`
- `/retitle pause`
- `/retitle resume`

Optional status/debug surface:

- a small status pane or widget showing auto-title mode, current title, last auto title, trigger state, selected model, and latest error if any

### User override rule

If the current session name no longer matches the last auto-applied title, automation should assume the user or another explicit action renamed the session and should pause future auto-refreshes unless the user explicitly resumes or forces a rename.

## Design Decisions

## 1. Create a dedicated auto-title extension

Add a new root extension entry point:

- `extensions/session-auto-title.ts`

Back it with a small module set:

- `extensions/session-auto-title/controller.ts`
- `extensions/session-auto-title/context.ts`
- `extensions/session-auto-title/state.ts`
- `extensions/session-auto-title/prompt.ts`
- `extensions/shared/settings.ts`

Why separate it from `session-hooks.ts`:

- indexing hooks are persistence/search infrastructure
- titling is user-facing session UX with different state, retries, and throttling needs
- a separate controller keeps the package easier to reason about and test

## 2. Use `pi.setSessionName()` as the only title write path

The title should be persisted only through Pi’s native session naming API.

In Pi parlance, this is the same session display name that built-in rename flows update. The extension is not creating a second metadata title. It is writing the same persisted session name that users see and can change via Pi’s normal naming UX such as `/name`.

Benefits:

- titles already show up in Pi session UI
- titles already persist in `session_info` entries
- titles already flow into existing index/search extraction with no schema changes
- user and extension writes converge on one canonical session name field

## 3. Use a two-phase naming flow

### Phase A — early initial title

For a new unnamed session, generate the first title from the earliest meaningful user prompt.

Recommended trigger:

- observe `input` to capture the first raw user text candidate
- wait until `turn_end` to actually run the LLM rename

Why not rename directly inside `input`:

- avoids delaying first-turn UX
- avoids titling from a prompt that is later transformed, cancelled, or errors
- keeps title generation on the same “session state is now durable” boundary used elsewhere in the package

Optional polish:

- derive a provisional local fallback title from the first prompt immediately
- overwrite it later with the LLM-generated title

That fallback is inspired by `pi-smart-sessions`, but should be treated as optional polish rather than required v1 behavior.

### Phase B — periodic refresh

After the initial title, refresh every configurable number of user turns.

Recommended default:

- `refreshTurns = 4`

User turns are a better refresh unit than raw entry count because they map to real topic drift and are stable across tool-heavy turns.

More specifically:

- a newly completed user turn is the trigger unit for considering a retitle
- the retitle should still run at `turn_end`, not during `input`
- the triggering user turn should be included in the titling context
- assistant/tool-only churn should not independently trigger periodic retitles

## 4. Title from the active branch context, not the full session tree

Auto-titling should reflect what the user is currently doing.

Use the current active branch context from Pi’s branch APIs:

- `ctx.sessionManager.getBranch()` for raw branch-local entries and extension state inspection
- `buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId())` when an LLM-ready branch context is needed

Then derive titling input from that branch only.

Why not use the full rendered session tree:

- titles should reflect the current thread, not abandoned branches
- full-tree rendering is more expensive than needed
- periodic refresh wants a cheap, repeatable summary input

## 5. Build titling context from the full active-branch conversation

Auto-titling should use the full active-branch conversation so far, not just a recent-message window.

Implementation direction:

- reuse the same branch-to-conversation rendering approach already used by handoff
- follow the same branch-local conversation serialization pattern already used by handoff, while calling Pi’s native helpers directly
- derive the title from the full conversation text plus a small amount of metadata

Suggested payload shape:

- `cwd`
- current session name, if any
- user turn count
- assistant turn count
- full current-branch conversation text

Implementation note:

- `buildSessionContext(...)` should remain the source of truth for the active branch LLM context because it already handles compaction summaries and branch-local message resolution
- the implementation should rely on Pi’s native branch-context helpers so both handoff and auto-title stay aligned on what the active branch conversation means

The naming prompt should still stay deterministic even though it receives the full branch conversation.

Example intent:

- produce one concrete title
- 3–15 words preferred
- maximum 120 characters
- no quotes
- no trailing punctuation
- mention the concrete task, feature, bug, or investigation
- let the most recent work refine the title when it materially narrows the task
- avoid vague titles like “Coding help” or “Working on project”

## 6. Prefer a cheap titling model, with fallback to current model

Model selection policy:

1. configured titling model, if present
2. otherwise, walk a small internal fallback list of cheap models and use the first one that is available and authenticated
3. current active session model as fallback

Use this default internal fallback order in v1:

1. `google/gemini-flash-lite-latest`
2. `anthropic/claude-haiku-4-5`
3. `openai/gpt-5.4-mini`

That list intentionally stays short, deterministic, and cost-conscious while covering the major provider families.

This mirrors the package’s existing pattern of resolving auth from `ctx.modelRegistry`.

The titling call should:

- use a low max token limit
- use a short timeout
- fail quietly without breaking the session

If generation fails:

- keep the current title
- optionally surface a small warning only for manual `/retitle`, not background auto-refresh

## 7. Add normalization and “material change” checks

Borrow this idea directly from `pi-tmux-window-name`.

Before applying a generated title:

- trim whitespace from the model response
- collapse repeated internal whitespace in the model response
- strip wrapping quotes from the model response
- enforce max length on the model response
- reject empty results

Then compare normalized titles.

Outside of model-response cleanup, treat persisted session names and stored auto-title state as already normalized. The extension should compare and persist those values directly rather than repeatedly re-normalizing them.

If the next title is effectively the same as the current title, skip writing a new `session_info` entry.

This avoids noisy history and pointless reindex churn.

## 8. Persist auto-title state in custom entries

Use a durable custom entry type, for example:

- `pi-sessions.auto-title`

Suggested state fields:

- `version: 1`
- `mode: "active" | "paused_manual"`
- `lastAutoTitle?: string`
  - store the last title that the extension itself successfully applied through `pi.setSessionName()`
- `lastAppliedUserTurnCount?: number`
- `lastTrigger?: "initial" | "periodic" | "manual"`
  - this is for provenance/debugging, not pause state
  - for example, a successful manual `/retitle` may leave `lastTrigger: "manual"` while still returning `mode` to `"active"`
- `updatedAt: string`

`lastAutoTitle` belongs in the durable custom state entry, not in a separate database or sidecar. That keeps manual-override detection branch-local and resume-safe.

This is not for storing the title itself. It is for storing controller state across:

- reload
- session resume
- session switch
- fork/new child session

## 9. Infer manual override by comparing current name with last auto title

Because Pi already has built-in naming flows, the extension should not try to replace them.

Instead, on relevant lifecycle boundaries, compare:

- persisted `lastAutoTitle`
- current session name from session state

If they differ, treat that as a manual override and move state to `paused_manual`.

That comparison should also treat an empty/cleared current session name as a manual override when `lastAutoTitle` exists. In other words, once the user changes or clears an auto-applied title, automation should stop retitling that session until the user explicitly asks for a retitle.

That gives a simple rule:

- auto-generated names may continue evolving while automation remains active
- user-set names are sticky forever for that session unless the user explicitly re-enables auto titling via `/retitle`

## 10. Guard against duplicate, concurrent, and stale renames

Adopt the core safeguards used in `pi-tmux-window-name`:

- one in-flight generation at a time
- per-session attempt bookkeeping
- session epoch or session-file token so stale async completions cannot rename the wrong session
- debounce so multiple lifecycle events around the same turn do not trigger duplicate work

Recommended controller/runtime fields:

- `currentSessionFile`
- `sessionEpoch`
- `inFlightRename?: Promise<void>`

Durable state such as `mode`, `lastAutoTitle`, and `lastAppliedUserTurnCount` should be rebuilt from the current branch’s custom entries rather than mirrored in extra in-memory bookkeeping.

## 11. Manual command should be command-only

Add a command:

- `/retitle`

Behavior:

1. `await ctx.waitForIdle()`
2. build the latest titling context from the current branch
3. force a title recomputation
4. apply it even if the session is currently paused due to prior auto/manual mismatch
5. if the recompute succeeds, set durable state back to `mode: "active"` and update `lastAutoTitle`
6. notify the user with the result

Why command-only:

- matches existing `ctx.waitForIdle()` and session-modifying command patterns
- avoids deadlocks or session mutation from event handlers
- gives a clean manual escape hatch even if automation is paused

## 12. Keep settings narrow in v1

Add settings under a new namespace such as:

```json
{
  "sessions": {
    "autoTitle": {
      "refreshTurns": 4,
      "model": "google/gemini-flash-lite-latest"
    }
  }
}
```

Recommended v1 settings:

- `refreshTurns: number`
  - default: `4`
- optional `model: string`
  - use Pi's fully-qualified `provider/modelId` format, for example `google/gemini-flash-lite-latest`

Keep v1 intentionally narrow. Internal defaults can still govern enablement, prompt limits, normalization, and model fallback behavior.

## Lifecycle Plan

### `session_start`

- load durable auto-title state from custom entries
- inspect current session name
- restore paused/active mode
- do not immediately retitle on resume

### `input`

- ignore extension-originated input
- ignore empty/whitespace-only input
- if this is the first substantive user prompt candidate for the session, cache it in memory

### `turn_end`

- detect whether a new user turn just completed on the active branch
- count current user turns on the active branch
- if unnamed and first title has not been applied, run initial titling using the just-completed user turn in context
  - this initial titling path is independent of `refreshTurns`
  - even when `refreshTurns > 1`, the first completed substantive user turn should still trigger the initial auto-title
- else if auto mode is active, a new user turn completed, and the refresh threshold is reached, run periodic titling using the just-completed user turn in context
- do not trigger periodic retitles from assistant/tool-only activity
- persist updated controller state

### `session_switch`

- drop in-memory session-specific state for the previous session
- restore durable state for the new session
- no immediate retitle by default

### `session_fork`

- let the child session start unnamed
- child session gets its own first-title flow based on its own subsequent context

### `session_shutdown`

- flush any final state if needed
- clear in-memory controller state

## Prompt Strategy

Suggested system prompt shape:

- you generate short, concrete session titles
- output title text only
- prefer 3–15 words
- stay within 120 characters
- describe the current coding task or investigation
- use the full current-branch conversation, while letting recent messages refine the title when needed
- mention specific subsystem/file/feature only if it improves clarity
- do not use quotes, prefixes, emojis, or punctuation unless essential
- avoid generic filler

Suggested user payload shape:

- session cwd
- current title
- reason for retitle: initial / periodic / manual
- user turn count
- assistant turn count
- full current-branch conversation

## Files to Modify

### New files

- `extensions/session-auto-title.ts`
- `extensions/session-auto-title/controller.ts`
- `extensions/session-auto-title/context.ts`
- `extensions/session-auto-title/prompt.ts`
- `extensions/session-auto-title/state.ts`
- `extensions/shared/settings.ts`
- `test/session-auto-title.command.test.ts`
- `test/session-auto-title.context.test.ts`
- `test/session-auto-title.state.test.ts`
- `test/session-auto-title.settings.test.ts`
- `docs/designs/05-session-auto-titling.md`

### Existing files likely touched

- `README.md`
- possibly `AGENTS.md` if new conventions or commands need mention

## Implementation Plan

### Phase 1 — initial auto-title for unnamed sessions

- add extension scaffold and settings reader for `sessions.autoTitle.refreshTurns` and `sessions.autoTitle.model`
- implement context builder from the full active-branch conversation, using Pi’s native branch-context helpers directly in the same way handoff does
- add `turn_end`-driven initial titling
- add normalization and no-op comparison
- add tests for first-title behavior and failure fallback

### Phase 2 — periodic refresh

- add user-turn counting
- add durable state entry and reload/resume restoration
- add refresh threshold logic
- add manual override detection and pause behavior
- add tests for repeated turns, no-op renames, and pause-on-manual-change

### Phase 3 — manual `/retitle`

- add command handler
- use `ctx.waitForIdle()`
- implement forced recompute
- add user-facing notifications
- add tests for forced rename and paused-session behavior

### Phase 4 — polish and documentation

- document settings and command usage in `README.md`
- tune prompt and normalization rules
- optionally add provisional first-prompt fallback title
- smoke-test with handoff-created child sessions, forks, compaction, and session switching

## Verification

### Automated coverage

- initial title applied once to unnamed sessions
- no rename when generated title normalizes to current title
- periodic refresh only fires at configured thresholds
- manual rename mismatch pauses automation
- `/retitle` forces recompute even when paused
- reload/session resume restores state correctly
- stale async completion cannot rename the wrong switched session

### Smoke test

1. start a new unnamed session
2. send first prompt
3. confirm title appears after first turn
4. continue for enough turns to cross refresh threshold
5. confirm title updates only when meaningfully different
6. use `/name My Fixed Title`
7. confirm future auto-refreshes stop
8. run `/retitle`
9. confirm title is recomputed from current state

## Rejected Alternatives

### Rename on every turn

Too noisy, too expensive, and too likely to churn between similar titles.

### Use the full rendered session tree for every rename

Overkill for the task and more likely to produce titles that reflect abandoned branches instead of current work.

### Reuse the indexing hook controller directly

Indexing and titling have different durability and UX concerns. Sharing the controller would create an awkward abstraction.

### Add a brand-new title table to the SQLite sidecar

Not needed. Pi’s native session naming already persists exactly what we need.

## Summary

The cleanest implementation is:

- a new dedicated `session-auto-title` extension
- native title writes through `pi.setSessionName()`
- initial title after the first completed turn
- periodic refresh every configurable number of user turns
- durable controller state via custom entries
- pause-on-manual-override behavior
- a command-only `/retitle` escape hatch

That keeps v1 small, fits the package’s existing architecture, and borrows the right ideas from both reference extensions without importing their extra scope.

