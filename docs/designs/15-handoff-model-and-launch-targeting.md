# Handoff Model and Launch Targeting

## Status

Accepted

## Decision Summary

> **Later refinement:** [Design 16](16-pi-0806-session-transcript-modernization.md) supersedes this design's exact-only model resolution with Pi's public `resolveCliModel` plus an authenticated-availability guard, adds Pi 0.80.6 `max`, and defines rich kickoff and launch-receipt rendering. The launch-backend seam and targeting surfaces remain in force; the detached backend is renamed to deferred.

Handoffs gain two targeting axes. First, the `session_handoff` tool and `/handoff` command can direct the child session to a different model and thinking level, defaulting to the current session's values. Second, session _creation_ is decoupled from session _launch_ behind a launch-backend seam, and a `detached` backend ships alongside Ghostty — the tool works everywhere, returning (and copying to clipboard) the resume command instead of opening a pane. The key tradeoff: a breaking tool-schema change (`launch` replaces `splitDirection`) in exchange for one parameter that cannot express contradictions.

## Problem Statement / Background

Handoffs spawn a child pi session, but the caller has no say in what model runs it. Concrete cases:

- A session on an expensive model wants to fork a mechanical side task to a cheaper one.
- A session on a fast model hits a design problem worth forking to a stronger model at higher thinking.

Today the tool path hardcodes inheritance: `formatModelArgument(ctx.model, pi.getThinkingLevel())` builds `provider/id:thinkingLevel` and passes it as `pi --model`. The plumbing exists; only the choice is missing.

The command path is worse: split `/handoff` passes no `--model` at all, so the child pane launches with the user's _saved default_ model rather than the current session's. That inconsistency is a bug independent of this feature.

Separately, the launch mechanism is welded to Ghostty on macOS: the tool does not register at all outside Ghostty (`isGhosttyHandoffAvailable()` gate), even though session-file creation and bootstrap encoding (`createHandoffSession`, `encodeHandoffBootstrap`, `buildPiResumeCommand`) are terminal-independent. Only the final AppleScript wrapper is Ghostty-specific. Tmux was already explored and deferred (`docs/designs/09-tmux-handoff-backend.md`); the missing piece was a seam that lets launch mechanisms plug in without touching handoff orchestration.

pi cannot enumerate models in a static tool description — `modelRegistry` lives on `ExtensionContext`, not `ExtensionAPI` — so discovery needed its own design. pi source (v0.80.3) sanctions post-load `registerTool()` re-registration (`loader.ts` calls `runtime.refreshTools()`), which unlocks description and schema shaping at `session_start`.

## Goals

- The agent can pick any available model and thinking level for a handoff child, and learns what is available without a failed probe call.
- `/handoff` users can override model/thinking with a flag, with autocompletion over available models.
- Split `/handoff` inherits the current model and thinking level by default, matching the tool path.
- Session creation is decoupled from launch: Ghostty, detached, and future backends (tmux, anything else) plug into the same contract.
- Handoffs work without Ghostty: the detached backend returns the resume command and copies it to the clipboard.

## Non-Goals

- **Verbosity control.** pi exposes no CLI flag or extension surface for it; codex verbosity is hardcoded internally (`openai-codex-responses.ts`). Nothing to forward. Upstream feature if ever wanted.
- **Tmux backend implementation.** Design 09 stays Deferred; this design only guarantees the seam it would plug into.
- **Interactive model picker in the handoff review flow.** Deferred until the `--model` flag proves insufficient.
- **Agent-initiated in-place session replacement.** Not possible without upstream pi changes; see Alternatives.
- **Forwarding other CLI flags** (`--no-extensions`, tool scoping, etc.).

## Exposed Shape

### Agent ↔ `session_handoff` tool

The tool is always registered, in every environment. Parameters:

- `launch: "left" | "right" | "up" | "down" | "detached"` — **replaces `splitDirection`** (breaking change). `detached` creates the session without launching anything and returns the resume command; direction values open a Ghostty split. The default schema offers only `detached`; the session-start re-registration upgrades it to include the four directions when Ghostty is available.
- `model?: string` — `provider/model-id` form. Default: current session's model. The description carries the list of available models, snapshotted at `session_start`.
- `thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh"` — default: current session's thinking level. The description states that overriding is rare: the current level is almost always correct, and it should change only when the task clearly warrants more or less reasoning.
- `goal`, `cwd`, `requestResponse` — unchanged.

Failure behavior: an unrecognized or auth-lacking model errors with the current available list so the agent self-corrects in one retry. A split `launch` value in a non-Ghostty environment (stale schema) degrades to `detached` with a note in the result rather than erroring. Detached results always include the resume command in the tool result text; the clipboard copy is a side effect.

### User ↔ `/handoff` command

```
/handoff [--left|--right|--up|--down|--detached] [--model provider/id[:thinking]] <goal>
```

- `--detached` is mutually exclusive with direction flags (same rule as between directions). It runs the normal draft-review flow, creates the child session, copies the resume command to the clipboard, and notifies.
- `--model` applies to all paths. Split and detached: becomes the child's `pi --model` argument. Non-split in-place: applied to the replacement session via `pi.setModel()` + `pi.setThinkingLevel()`.
- Argument autocompletion completes `--model <partial>` from the model snapshot, in the style of the built-in `/model` command. Unknown model values error before draft generation, listing available models.
- Absent `--model`, split and detached handoffs inherit the current model and thinking level.

### Handoff orchestration ↔ launch backend

The internal seam. Session creation (id, session file, bootstrap encoding, resume command construction) is backend-independent and happens first; a launch backend then takes over:

- **Crosses the boundary:** `{ cwd, title, resumeCommand }` plus backend-specific configuration held by the backend itself (Ghostty: direction, terminal id, focus behavior; detached: clipboard setting).
- **Backend returns:** success with an optional user-facing message (detached returns the resume command as its message), or failure with an error.
- **Ownership:** orchestration owns session creation and the guarantee that _every_ failure path still surfaces the resume command — the session file already exists and must remain startable manually. Backends own only the mechanics of getting the command running (or delivered).

### Settings

- `handoff.detached.copyToClipboard` (default `true`) — whether detached handoffs copy the resume command to the clipboard. Delivery preference belongs to the user, not the agent; see Decision 7.

### pi-sessions ↔ child pi process

Unchanged: the resolved model choice is encoded as `pi --model 'provider/id[:thinking]'` in the resume command. The child owns final resolution (capability clamping, warnings) via pi's `resolveCliModel`.

## Design Decisions

### 1. Separate `model` and `thinkingLevel` tool parameters

Rather than one combined `provider/id:thinking` string (pi CLI style), the tool takes two independent optional parameters. The agent can raise thinking without restating the model, TypeBox validates the thinking enum at the schema boundary, and defaults compose independently. The combined form survives only at the spawn boundary and in the `/handoff` flag, where a single token is ergonomically necessary.

### 2. Discovery via session-start snapshot, validation at execute

At `session_start`, the extension captures `ctx.modelRegistry.getAvailable()` into extension state and re-registers the `session_handoff` tool with the model list embedded in the `model` parameter description. The same cached snapshot feeds `/handoff` autocompletion (whose `getArgumentCompletions` callback receives no `ctx`).

The list is description text, not a `Type.Union` of literals: a stale enum is a hard schema failure the agent cannot escape, while a stale description degrades to a soft execute-time error carrying the corrected list. Execute-time validation is strict — exact `provider/model-id` match against a fresh `getAvailable()` — because fuzzy matching that silently lands on the wrong model in a background pane is worse than one visible retry.

### 3. Split `/handoff` inherits current model — bug fix folded in

Split `/handoff` currently omits `--model`, so children launch with the saved default. Both `/handoff` split paths (direct and `--identify` fallback) now pass the current model + thinking level, exactly as the tool path already does. This lands as its own commit before the feature work.

### 4. Creation and launch are decoupled behind a launch-backend seam

Handoff orchestration always performs the same steps — create session file, encode bootstrap, build resume command — and then hands `{ cwd, title, resumeCommand }` to a launch backend. Ghostty (AppleScript split) and detached (return + clipboard) are the two initial backends; tmux (design 09) or anything else plugs in later without touching orchestration. The resume command is the universal contract: every backend is ultimately a strategy for getting that one string executed, whether by a terminal or a human.

The seam mostly formalizes an existing split: `createHandoffSession` and `buildPiResumeCommand` were already terminal-independent; only the AppleScript wrapper is Ghostty's. Shipping detached in the same change proves the interface with a second implementation — a seam with one consumer is speculative abstraction.

### 5. `launch` replaces `splitDirection` — one parameter, no contradictions (breaking change)

A separate `detached` flag or an optional `splitDirection` would allow contradictory or silently-changed requests. One required union — four directions plus `detached` — makes invalid combinations inexpressible. Repo policy: never fear breaking backwards compatibility when it serves the goal. Tool guidelines keep the rule that the launch target comes from the user, not agent initiative.

### 6. Detached is the default; Ghostty is an upgrade at session_start

The Ghostty registration gate inverts with detached available: the tool registers everywhere. Load-time registration cannot know the environment, so it ships the safe floor — `launch` offers only `detached`. The `session_start` re-registration (Decision 2), which does have `ctx`, _upgrades_ the `launch` enum to add the four directions when Ghostty on macOS is present. The agent therefore never sees a split value it cannot use. As backstop for a stale schema (environment changed after re-registration), a split request without Ghostty degrades to `detached` at execute, noting the substitution in the result. Degrading beats erroring here because the session is already worth creating; only the delivery mechanism is unavailable.

### 7. Detached delivery: result text always, clipboard by setting — not an enum value

A `detached-clipboard` variant was considered and rejected: how the user wants to receive the command is a user preference the agent cannot know, so it must not be an agent-facing parameter. The resume command always appears in the tool result (the model needs it to report to the user); the clipboard copy is a side effect controlled by `handoff.detached.copyToClipboard` (default on), using `copyToClipboard` exported from `@earendil-works/pi-coding-agent` (already used by the auto-title wizard). Clipboard failure is non-fatal — the command is already in the result.

### 8. Non-split `/handoff --model` applies via `pi.setModel()` inside `withSession`

The in-place path replaces the session in-process, so the CLI `--model` string does not apply. Instead, the flag value is resolved against the registry up front (before draft generation), and `pi.setModel()` + `pi.setThinkingLevel()` are called inside the `ctx.newSession` `withSession` callback — after the switch, so cancelling the handoff at review leaves the current session's model untouched. `setModel` returns `false` when auth is missing; up-front validation against `getAvailable()` makes that unreachable in practice, but a `false` return still notifies and proceeds with the inherited model rather than aborting a session switch that already happened.

## Edge Cases & Failure Modes

- **Model becomes available/unavailable mid-session (auth change):** the description snapshot goes stale; execute-time validation against a fresh `getAvailable()` catches it and returns the corrected list.
- **Agent passes a model in `provider/id:thinking` form to the tool's `model` param:** validation fails exact match; error message notes thinking belongs in `thinkingLevel`.
- **`thinkingLevel` unsupported by the chosen model:** passed through; child pi's `resolveCliModel` clamps and surfaces its own diagnostic.
- **Split `launch` value without Ghostty (stale schema):** degrade to `detached`; result notes the substitution and carries the resume command.
- **Ghostty launch failure:** as today — error includes the resume command for manual start, now built by the same orchestration guarantee that covers all backends. The command must include the chosen model.
- **Clipboard copy fails on detached:** non-fatal; the resume command is already in the tool result / notification.
- **`/handoff --model` with no value (flag is last token):** usage error, reusing the existing `HANDOFF_USAGE` pattern.
- **`/handoff --model unknown/model`:** command errors before draft generation, listing available models.
- **`/handoff --detached --left`:** usage error — one launch target only, same rule as conflicting direction flags.
- **Non-split `/handoff --model` where `setModel` returns `false`:** notify the failure and continue with the inherited model; the session switch has already happened and must not abort.
- **No current model and no override (`ctx.model` undefined):** existing "No model selected" error paths remain.

## Alternatives

### `Type.Union` of model literals in the tool schema

- **Status:** Rejected
- **Decision:** Stale enums hard-fail schema validation with no recovery path for newly available models; a description list plus soft execute-time error self-corrects.
- **Discussion:** Enum would give provider-side validation for free, and would be worth revisiting if pi ever supports refreshing tool schemas on registry changes. Note the `launch` enum _is_ shaped per environment — that is acceptable because launch availability changes only with the hosting terminal, not mid-session.

### Fuzzy model resolution (pi `resolveCliModel` style) in the tool

- **Status:** Rejected
- **Decision:** A fuzzy match that lands on the wrong model launches a wrong-model background session the user may not notice for some time. One list-bearing error retry is cheaper.

### `detached-clipboard` as a distinct `launch` value

- **Status:** Rejected
- **Decision:** Delivery preference is the user's, not the agent's; encoding it in the tool schema asks the agent to know something it cannot. A setting (`handoff.detached.copyToClipboard`) carries the preference instead.

### Interactive model picker in the handoff review flow

- **Status:** Open
- **Open Issue:** The `--model` flag requires knowing the model name up front; a picker in the review modal would allow choosing at review time.
- **Next step:** Use the flag for a while; add the picker if the flag proves clumsy in practice.

### Agent-initiated in-place session replacement (tool handoff replacing the current session)

- **Status:** Rejected
- **Decision:** Not feasible in pi v0.80.3 without upstream changes. Three walls: (1) `newSession()` exists only on `ExtensionCommandContext` (`core/extensions/types.ts:347`), which pi hands exclusively to command handlers (`core/agent-session.ts:1187`) — tool `execute` and event handlers receive plain `ExtensionContext` with no session control; (2) there is no programmatic command invocation — `pi.sendUserMessage` routes through `prompt()` with `expandPromptTemplates: false` (`core/agent-session.ts:1402`), deliberately bypassing slash-command parsing, so a tool cannot emit `/handoff ...`; (3) semantically, a tool executes mid-agent-turn, and replacing the session would tear down the agent loop awaiting that tool's own result — pi would need a "replace session after turn completes" primitive.
- **Discussion:** If this becomes wanted, the path is an upstream pi feature request, not an extension workaround. The detached backend covers part of the motivation: handoffs no longer require Ghostty.

## Reference: pi source map

For the implementing agent. Paths are relative to `~/.cache/pi-source/v0.80.3/packages/` — version-specific; confirm against the running pi version.

| Concern                                                                                                              | Location                                                                              |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `ThinkingLevel` union                                                                                                | `agent/src/types.ts` (`"off" \| "minimal" \| "low" \| "medium" \| "high" \| "xhigh"`) |
| `ModelRegistry.getAvailable()` / `.find()`                                                                           | `coding-agent/src/core/model-registry.ts:644,651`                                     |
| `ctx.modelRegistry`, `ctx.model` on `ExtensionContext`                                                               | `coding-agent/src/core/extensions/types.ts:300-316`                                   |
| `pi.setModel` / `pi.setThinkingLevel` on `ExtensionAPI`                                                              | `coding-agent/src/core/extensions/types.ts:1282-1288`                                 |
| `registerTool` re-registration (overwrites by name, calls `refreshTools()`)                                          | `coding-agent/src/core/extensions/loader.ts:227-234`                                  |
| `RegisteredCommand.getArgumentCompletions` contract                                                                  | `coding-agent/src/core/extensions/types.ts:1113-1119`                                 |
| Built-in `/model` completion — the pattern to copy (fuzzy filter, `provider/id` labels)                              | `coding-agent/src/modes/interactive/interactive-mode.ts:500-529`                      |
| Autocomplete argument-prefix semantics: callback receives full argument text; chosen `item.value` replaces all of it | `tui/src/autocomplete.ts:339-358` (prefix extraction), `:375+` (`applyCompletion`)    |
| `--model provider/id:thinking` shorthand handling in child pi (`resolveCliModel`)                                    | `coding-agent/src/main.ts:368-392`, `coding-agent/src/core/model-resolver.ts`         |
| `newSession` / `withSession` (`ReplacedSessionContext`)                                                              | `coding-agent/src/core/extensions/types.ts:347-351,378-385`                           |
| `copyToClipboard` (cross-platform, exported from `@earendil-works/pi-coding-agent`)                                  | pi export; existing usage in this repo: `extensions/session-auto-title/wizard.ts:460` |

Repo-local anchors: creation/spawn logic in `extensions/session-handoff/spawn.ts` (`createHandoffSession`, `buildPiResumeCommand`, `buildPiLaunchCommand`, `launchSplitHandoffSession`); tool + command registration in `extensions/session-handoff.ts` (`executeSessionHandoffTool`, `parseHandoffCommandArgs`, `formatModelArgument`); settings schema in `extensions/shared/settings.ts`.

## Implementation Plan

- [x] Phase 1: Split `/handoff` inherits current model
  - Goal: Bug fix — split `/handoff` children launch with the current session's model + thinking level instead of the saved default.
  - Files: `extensions/session-handoff.ts`, `test/session-handoff.command.test.ts`
  - Work: Pass `formatModelArgument(ctx.model, pi.getThinkingLevel())` through both `launchSplitHandoffSession` calls and the failure-fallback `buildPiResumeCommand` in the command handler; move `formatModelArgument` wherever both call sites reach it.
  - Validation: `npm run check`; test asserting the spawn command includes the current `--model` string.

- [x] Phase 2: Launch backend seam (prefactor, no behavior change)
  - Goal: Creation decoupled from launch; Ghostty becomes the first backend behind the seam.
  - Files: `extensions/session-handoff/spawn.ts` (likely split into a launch module, e.g. `extensions/session-handoff/launch/`), `extensions/session-handoff.ts`, `test/session-handoff.spawn.test.ts`
  - Work: Define the backend contract — input `{ cwd, title, resumeCommand }`, output success (optional user-facing message) or failure (error string); backend-specific config (direction, terminal id, focus) lives with the backend. Rehome `createHandoffSession` + `buildPiResumeCommand` as the orchestration side; wrap the existing AppleScript logic as the Ghostty backend. Preserve the invariant that every failure path surfaces the resume command. Tool and command behavior identical before/after.
  - Validation: `npm run check`; existing spawn/command tests pass with mechanical updates only.

- [x] Phase 3: Tool `model` + `thinkingLevel` parameters with strict validation
  - Goal: Agent can override model and thinking level on `session_handoff`; invalid models error with the available list.
  - Files: `extensions/session-handoff.ts`, `test/session-handoff.extension.test.ts`
  - Work: Add optional `model` (string) and `thinkingLevel` (thinking-level union) to the tool schema — the `thinkingLevel` description must state that overriding is rare and the current level is almost always correct; in `executeSessionHandoffTool`, resolve overrides — exact match of `model` against `ctx.modelRegistry.getAvailable()`, error listing `provider/id` values on miss — and feed the resolved pair into `formatModelArgument`.
  - Validation: `npm run check`; tests for default inheritance, valid override, unknown-model error content, thinking-only override.

- [x] Phase 4: Session-start snapshot and dynamic tool re-registration
  - Goal: The tool description enumerates available models so the agent chooses without a probe call; the snapshot is cached in extension state for later phases.
  - Files: `extensions/session-handoff.ts`, `test/session-handoff.extension.test.ts`
  - Work: Extract tool registration into a function parameterized by the model list (and, after Phase 5, the launch-value set); call it at extension load (empty list) and re-register at `session_start` with `ctx.modelRegistry.getAvailable()` cached in extension state.
  - Validation: `npm run check`; test that re-registration injects model ids into the `model` parameter description; smoke test in a live session confirming the description the agent sees.

- [x] Phase 5: `launch` parameter + detached backend
  - Goal: Tool registers everywhere; agent selects `left|right|up|down|detached`; detached returns the resume command and copies it to the clipboard.
  - Files: `extensions/session-handoff.ts`, `extensions/session-handoff/launch/` (detached backend), `extensions/shared/settings.ts`, `test/session-handoff.extension.test.ts`
  - Work: Replace `splitDirection` with required `launch` union (breaking change; update tool guidelines text). Remove the `isGhosttyHandoffAvailable()` registration gate; register with `launch` offering only `detached` at load, and upgrade the enum to add the four directions at `session_start` re-registration when Ghostty is available. Implement the detached backend: success message carries the resume command; clipboard copy via pi's `copyToClipboard`, gated by new setting `handoff.detached.copyToClipboard` (default true), copy failure non-fatal. Execute-time degrade: split value without Ghostty → detached, substitution noted in result. Result rendering updated for detached (no direction, show resume command).
  - Validation: `npm run check`; tests for detached result content, clipboard setting off, degrade path, schema shaping per environment; manual smoke test — detached handoff from a live session, paste and run the resume command.

- [x] Phase 6: `/handoff --detached`
  - Goal: Interactive detached handoff — full draft-review flow, then clipboard + notify instead of a split.
  - Files: `extensions/session-handoff.ts`, `test/session-handoff.command.test.ts`
  - Work: Add `--detached` to `parseHandoffCommandArgs`, mutually exclusive with direction flags; after draft approval, run creation + detached backend; notify that the resume command was copied (and include it in the notification for the no-clipboard case).
  - Validation: `npm run check`; parser tests (conflict with direction flags); flow test asserting no Ghostty invocation and correct notification; manual TUI check.

- [x] Phase 7: `/handoff --model` flag (all paths)
  - Goal: Users override model/thinking per handoff via flag, on split, detached, and in-place handoffs.
  - Files: `extensions/session-handoff.ts`, `test/session-handoff.command.test.ts`
  - Work: Extend `parseHandoffCommandArgs` with `--model <provider/id[:thinking]>` — `--model` consumes the next token; split on the last `:` only when the suffix is a valid thinking level. Validate against `ctx.modelRegistry` before draft generation. Split/detached paths: feed into the resume command's `--model` string. Non-split path: call `pi.setModel()` + `pi.setThinkingLevel()` inside the `withSession` callback (see Decision 8).
  - Validation: `npm run check`; parser tests (flag with/without thinking suffix, missing value, unknown model, flag position among goal words); tests that the resume command carries the override and that non-split applies `setModel` after switch.

- [x] Phase 8: `--model` argument autocompletion
  - Goal: Typing `/handoff ... --model <partial>` completes over available models.
  - Files: `extensions/session-handoff.ts`, `test/session-handoff.command.test.ts`
  - Work: Add `getArgumentCompletions` to the `/handoff` registration. Tricky contract (see source map): the callback receives the _entire_ argument text after `/handoff`, and the selected item's `value` replaces all of it. So: detect that the text ends in a `--model` value position (trailing `--model` or `--model <partial>`); fuzzy-filter the session-start model snapshot by the partial (mirror `interactive-mode.ts:500-529`); return items whose `value` is the untouched leading text + `--model provider/id`, with `label`/`description` showing just model id and provider. Return `null` when not in a `--model` value position so file completion behavior is unaffected. The callback receives no `ctx` — use the cached snapshot from Phase 4.
  - Validation: `npm run check`; completion tests (value-position detection, full-argument replacement values, null outside `--model` position, empty snapshot); manual TUI check.
