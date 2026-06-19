# 08 — Background session handoff tool

## Status

Accepted

## Decision Summary

Expose an LLM-callable `session_handoff` tool for agent-initiated background handoffs only. The tool launches a Ghostty split from the correct source terminal, returns once the child session is started, and pushes draft generation plus review into the child session so the parent agent can continue quickly.

## Problem Statement

The `/handoff` command already creates focused child sessions from the current conversation. That covers human-initiated handoff, but it does not let an agent proactively create a new working thread after asking the user where it should go.

The desired tool should reuse the same extraction and child-session machinery as `/handoff`, while changing where the expensive and interactive work happens. A background tool call should only create the child session and spawn the destination pane. The child session should then generate the handoff draft, show the preview/countdown, and send or prefill the prompt based on the user's review choice.

Foreground tool handoff is not currently implementable cleanly inside `pi-sessions`. Pi exposes `newSession()` and `switchSession()` only to `ExtensionCommandContext`, not to tool execution contexts. A tool can create session files and launch split panes, but it cannot take over the current session without a Pi core API change.

## Goals

- Register an LLM-callable `session_handoff` tool only when Ghostty split launch is available.
- Require an explicit split direction from the user; agents must not guess.
- Allow an optional target working directory for related work in another repo.
- Launch a new Ghostty split from the current session's terminal, not whichever terminal happens to be focused later.
- Let the original agent continue after the child is launched.
- Run handoff extraction in the child session for tool handoffs.
- Show the review/countdown UI in the child session before sending the handoff prompt.
- Inherit the current model and thinking level for the child session when launching the split.
- Write durable handoff metadata only after the child review accepts or edits the prompt.
- Prefactor handoff orchestration so parent-generated and child-generated handoffs can share small composable steps.

## Non-Goals

- Foreground takeover from a tool.
- Non-Ghostty fallback behavior.
- Cross-pane reporting of whether the child review was accepted, edited, or cancelled.
- Inheriting model-cycling scopes or active tool configuration.
- Replacing `/handoff`; the command remains the foreground-capable path.
- Moving split-command extraction into the child; `/handoff --right` remains a parent-reviewed interactive command flow.
- Pi core changes.
- Tmux support in this feature.

## Design Decisions

### 1. The tool is background-only

`session_handoff` should only support split-pane handoffs.

It should not expose `launchMode`, `foreground`, or `background` parameters. Those names imply a choice the tool cannot actually honor. The schema should instead require the concrete launch decision that matters for the only supported path: `splitDirection`.

This keeps the tool honest. Foreground handoff remains available through `/handoff`, where command contexts have the session-control APIs needed to switch sessions.

### 2. Register the tool only when Ghostty is available

Because the tool can only work as a background split, the extension should not register `session_handoff` unless the current process is running on macOS inside Ghostty.

The minimum startup gate should be:

- `process.platform === "darwin"`
- `process.env.TERM_PROGRAM === "ghostty"`

The command path can keep its current fail-at-use behavior. The tool path should be stricter because registration changes the model's available tool list. If the tool cannot work in the current terminal, do not offer it to the agent.

### 3. The agent must obtain the split direction proactively

The tool parameters should require:

- `goal`: the new session's task or intent
- `splitDirection`: `left`, `right`, `up`, or `down`

The tool prompt guidelines should explicitly say that the agent must ask the user for the split direction before calling `session_handoff`. There is no default direction.

The purpose is not just validation. The user is deciding where a visible new working surface appears. Guessing is hostile UI.

### 4. Support an optional target working directory

The tool should accept an optional working-directory field for handoffs into a different repo or related project.

Use a name that describes runtime behavior, not an assumption about Git. Recommended schema field:

- `cwd?: string`

Semantics:

- omitted: use the current session's `ctx.cwd`
- relative path: resolve against the current session's `ctx.cwd`
- absolute path: use as-is
- `~`: expand to the user's home directory if the codebase already has or adds a shared helper for that
- non-existent path: fail before creating or launching a child session
- existing non-directory path: fail before creating or launching a child session

The spawned Pi child should use the resolved directory as its working directory and session header `cwd`. The source conversation remains the parent session; the target directory is where the receiving agent will work.

### 5. Identify and reuse the correct Ghostty source terminal

The current split launcher uses Ghostty's `focused terminal of selected tab of front window`. That is acceptable for a user-invoked slash command, but unsafe for an agent tool. By the time a background agent calls `session_handoff`, the user's foreground Ghostty terminal may be unrelated.

The extension should track the best-known Ghostty terminal id for the current Pi session and split from that terminal when launching handoffs. Both the tool path and interactive split command may use this in-memory terminal id. For interactive `/handoff --left|--right|--up|--down`, the stored id should still be accurate in normal use and saves an extra AppleScript focus query; if it is missing, the command can still fall back to the focused terminal because the user is invoking it interactively from the intended pane.

Initial strategy:

- on interactive user input or `before_agent_start`, query Ghostty for `id of focused terminal of selected tab of front window`
- store the result in memory only, keyed to the live extension/session runtime
- when launching, resolve that id back to a Ghostty terminal and split from it
- if resolution fails in the tool path, fail clearly and ask the user to re-identify the terminal
- if resolution fails in the interactive command path, fall back to the focused terminal query before failing

Do not persist the terminal id into the session file. A restored session may occupy a different Ghostty terminal with a different id, and durable reuse would aim future handoffs at a stale surface. Losing the id on process restart is correct; the extension should capture a fresh id from new user input or `/handoff --identify`.

This is best-effort until Ghostty's AppleScript terminal `tty` property is widely available. Ghostty PR `ghostty-org/ghostty#11922` adds read-only `pid` and `tty` properties to the AppleScript terminal class and is targeted at Ghostty 1.4.0. Once available, the extension should prefer matching the current process TTY to Ghostty's terminal `tty` over relying on a previously captured focused terminal id.

### 6. Add a terminal-identification escape hatch

A user needs a way to repair misalignment when the stored Ghostty terminal id is wrong or stale.

Add a command affordance such as:

```sh
/handoff --identify
```

Behavior:

- treat `--identify` as an overriding mode
- ignore all other flags and text when `--identify` is present
- require Ghostty/macOS
- read the currently focused Ghostty terminal id
- store it in memory as the current session's handoff source terminal
- notify the user with the captured id or a clear failure

This command should not create a handoff. It only rebinds the source terminal for future background tool launches.

### 7. Return when the child session is launched and keep parent focused

The tool result should complete once the child has been created and launched successfully.

Tool handoffs should always be treated as unfocused launches: after creating the split, focus should unconditionally return to the parent/source terminal. This is stronger than the command path's interactive behavior because a background tool call should never steal the user's active surface.

The result may include:

- child session id
- child title if already known; for child-generated drafts this may initially be a provisional title
- split direction
- resolved working directory

It should not wait for child-side generation or review to complete, and it should not report review as a pending status. The original agent can continue its current work once the handoff has been kicked off.

### 8. Move generation and review into the spawned child for tool handoffs

The existing split command reviews the draft in the parent before launching the child. The tool path should differ: the parent creates the child and passes enough bootstrap data for the child to generate the handoff draft itself.

Child-side behavior:

1. read the bootstrap payload
2. load the parent session conversation as the source context
3. run structured handoff extraction using the child session's model and cwd
4. assemble the draft
5. show the preview/countdown
6. accept, edit, or cancel

Review outcomes:

- accept or timeout: send the draft as the first user prompt
- edit: open the editor with the draft, then send the edited text
- cancel: prefill the normal prompt editor with the draft and do not start an agent turn

This makes the parent tool call much faster and places the destination-specific review in the destination session.

### 9. Keep slash-command split handoff parent-generated

`/handoff --left|--right|--up|--down` should keep its current parent-side generation and review semantics.

A slash command is an intentional interactive action. The user asked for handoff now, in the current session, and should get the draft review there before anything launches. The tool is different: it is agent-initiated background delegation after the agent has asked for direction.

This creates two placement policies:

- command split: parent generates, parent reviews, child sends immediately
- tool split: parent launches, child generates, child reviews

The implementation should make these policies explicit rather than burying them in separate copy-pasted flows.

### 10. Prefactor handoff into composable steps

Before adding the tool path, refactor the existing handoff code into small orchestration units that can be composed by command and tool flows.

Useful seams:

- validate source conversation availability
- resolve target cwd
- create prepared child session file
- build bootstrap payload
- launch split from a resolved Ghostty terminal target
- generate handoff draft from an explicit source conversation, not only `ctx.sessionManager`
- review draft and produce an action result
- materialize metadata and send prompt
- prefill editor without starting a turn

The key refactor is to decouple handoff generation from "the current session entries on this context." Tool handoff generation runs in a fresh child context but uses the parent session as source material.

### 11. Write handoff metadata only after accept/edit sends the prompt

For tool handoffs, durable `pi-sessions.handoff` metadata should be written only when the child review accepts or edits the prompt and the prompt is sent.

If the user cancels review, the child remains open with the draft prefilled in the editor, but no handoff metadata is written.

This differs from the current split command path, where the child writes metadata on `session_start` and immediately sends the already-approved prompt. The tool path cannot treat the prompt as approved until child-side review completes.

### 12. Extend bootstrap semantics for child-side generation

The existing bootstrap payload is enough for command split handoff because the prompt has already been generated and approved in the parent. Tool handoff needs a child-generation startup mode.

The bootstrap payload should distinguish these activation policies:

- send immediately: existing command split behavior with an approved prompt
- generate and review in child: new tool behavior with source session reference and goal

The child `session_start` hook should branch on that policy. Immediate mode preserves current behavior. Generate-and-review mode runs extraction in the child, reviews the result, and materializes metadata only if the prompt is sent.

### 13. Inherit current model and thinking level for split launch

The spawned child should launch with the current model and thinking level where possible, using Pi's CLI model syntax:

- `--model provider/id`
- `--model provider/id:thinking` when a thinking level is available

This is intentionally narrower than full runtime inheritance. The tool does not need to preserve model cycling configuration, active tool sets, or other session-local state in this design.

### 14. No foreground hook workaround

Pi has lifecycle hooks such as `before_agent_start`, `agent_end`, `turn_end`, `message_end`, `tool_execution_end`, and `input`, but extension event handlers receive ordinary `ExtensionContext`. They do not receive `ExtensionCommandContext`, and therefore do not gain `newSession()` or `switchSession()`.

A tool result can set `terminate: true` to stop the agent after the tool batch, but the later hooks still lack session replacement APIs. The two-step idea does not unlock foreground takeover unless Pi core exposes command session controls to some post-turn extension context.

Foreground remains deferred.

### 15. Use only the Ghostty controls needed for launch

The implementation should rely on a narrow Ghostty AppleScript surface:

- query the stored source `terminal` by id from `terminals`
- create a `surface configuration`
- set `initial working directory` to the resolved target cwd
- set `command` to the Pi resume/launch command with bootstrap environment
- `split` the source terminal in the requested direction with that configuration
- for tool handoffs, always `focus` the source terminal after launch to preserve the parent pane focus

Do not add layout management in this feature. Resizing, equalizing, moving tabs, closing surfaces, and cross-tab placement are useful future affordances, but the first tool should only create a predictable adjacent pane.

### 16. Defer tabs, windows, and explicit layout placement

Ghostty can create tabs and windows via AppleScript, and tabs expose ids, names, 1-based indexes, selected state, and focused terminals. That is enough to consider future launch targets such as "new tab" or "split inside tab N."

Do not include those targets in the first tool. The current product decision is a visible neighboring split in the current session's terminal context. Adding tabs raises unresolved UX questions: whether new tabs steal focus, whether the tool should restore the previous tab afterward, how the agent should ask for a target tab, and how to avoid launching work somewhere the user cannot see.

Ghostty's AppleScript dictionary does not expose detailed split-tree geometry, relative pane sizes, or pane coordinates. The extension can count terminals in a tab/window and inspect ids/names/working directories, but it should not try to infer or manage exact layout shape.

### 17. No non-Ghostty fallback

The tool should use the same Ghostty split prerequisite model as `/handoff --left|--right|--up|--down`.

If Ghostty or macOS prerequisites fail during registration, do not register the tool. If they fail later during launch, fail clearly and avoid pretending there is an equivalent background handoff elsewhere.

## Edge Cases & Failure Modes

- **Tool loaded outside Ghostty:** do not register `session_handoff`.
- **No conversation context:** return an error; there is nothing meaningful to hand off.
- **No selected model:** return an error; extraction cannot run in the child unless a model is inherited or otherwise selected.
- **Missing split direction:** schema validation should reject the call.
- **Agent guessed the direction:** this is a prompt-guideline failure; the tool still receives a valid direction, but the system prompt should make the required user confirmation explicit.
- **Target cwd does not exist:** fail before creating or launching a child session.
- **Target cwd is not a directory:** fail before creating or launching a child session.
- **Stored Ghostty terminal id is missing:** fail and tell the user to run `/handoff --identify` from the intended source pane.
- **Stored Ghostty terminal id cannot be resolved for tool handoff:** fail and tell the user to run `/handoff --identify` again.
- **Stored Ghostty terminal id cannot be resolved for command split handoff:** fall back to the focused terminal query, then fail only if that also fails.
- **Multiple terminals look plausible:** fail closed unless a stored id or future TTY match identifies exactly one terminal.
- **Split launch fails after child file creation:** return an error with the created child session id and a manual resume command if the existing command path continues to support that recovery pattern.
- **Child generation fails:** show an error in the child session and leave the child open without metadata.
- **Child review is cancelled:** leave the child open, prefill the editor with the draft, do not send a user message, and do not write handoff metadata.
- **Child session already has user input before bootstrap materializes:** fail with the stale-session message and do not write metadata or send a prompt.
- **Child review accepts after metadata already exists:** avoid duplicate metadata; send the prompt if the session is otherwise fresh.
- **Foreground requested by the user:** the agent should tell the user to run `/handoff`; the tool does not expose a foreground mode.

## Rejected Alternatives

### Full foreground/background tool

Rejected.

Foreground handoff from a tool would need to switch the current session after review. Pi tool contexts and lifecycle event handlers are `ExtensionContext`, not `ExtensionCommandContext`, so they do not expose `newSession()` or `switchSession()`.

A workaround would require Pi core changes or a brittle command-action bridge. Both are outside this design.

### `launchMode` parameter with only one valid value

Rejected.

A `launchMode` parameter suggests the agent can choose between foreground and background. It cannot. The only supported tool behavior is split launch, so the schema should ask for `splitDirection` directly.

### Always using Ghostty's focused terminal at launch time

Rejected.

That is fine for a slash command invoked by a user in the active pane. It is wrong for background tool calls because the active Ghostty pane may have changed while the agent was working.

### Parent-side generation for tool handoffs

Rejected.

Parent-side generation is simpler because it reuses the command flow, but it blocks the parent agent on the expensive extraction step. The tool exists to make background delegation cheap from the parent session's perspective, so generation should move to the child.

### Writing metadata before child review

Rejected.

Metadata should represent an actual accepted handoff prompt. If the user cancels and only leaves the draft in the editor, recording it as a durable handoff would overstate what happened.

### Non-Ghostty fallback

Rejected.

A background handoff is specifically a visible new session surface. Without the Ghostty split mechanism, this package does not have an equivalent launch target. Failing clearly is better than inventing a second-class path.

## Integration Points

- `extensions/session-handoff.ts`: registers the command today and should conditionally register the new `session_handoff` tool only under Ghostty/macOS.
- `extensions/session-handoff/extract.ts`: should expose generation from explicit source messages/session data, not only the current `ctx.sessionManager`.
- `extensions/session-handoff/review.ts`: should expose review behavior usable from child `session_start`, including cancel-to-prefill behavior.
- `extensions/session-handoff/metadata.ts`: should extend bootstrap data to include immediate-send versus child-generate policies while preserving existing metadata parsing.
- `extensions/session-handoff/spawn.ts`: should support target cwd, inherited `--model` values, splitting from a resolved Ghostty terminal id, command fallback to focused terminal, and tool-path focus restoration.
- `pi.on("input")` or `pi.on("before_agent_start")`: should capture the likely source Ghostty terminal id when the user submits interactive input.
- `pi.on("session_start")`: should branch between immediate send and child-side generation/review.
- Existing `/handoff`: should keep current foreground and split command semantics while sharing the prefactored primitives.

## Implementation Plan

- [ ] Phase 1: Handoff orchestration prefactor
  - Goal: Make the existing command flow use small reusable primitives without changing behavior.
  - Files: `extensions/session-handoff.ts`, `extensions/session-handoff/extract.ts`, `extensions/session-handoff/review.ts`, focused tests.
  - Work: Extract source-context validation, draft generation from explicit messages, metadata creation, review result handling, and split launch preparation into named helpers.
  - Validation: Existing handoff command and spawn tests pass; add regression tests proving `/handoff` and `/handoff --right` behavior is unchanged.

- [ ] Phase 2: Ghostty terminal identity tracking
  - Goal: Store and reuse the correct source terminal id for background launches during the live process.
  - Files: `extensions/session-handoff.ts`, `extensions/session-handoff/spawn.ts`, possibly `extensions/session-handoff/terminal.ts`, tests.
  - Work: Add in-memory Ghostty terminal-id capture, stored-id lookup, launch splitting from stored terminal id, and `/handoff --identify` as an overriding command mode.
  - Validation: Unit-test AppleScript generation and stale-id failure behavior; manually verify identify then split from a non-focused pane.

- [ ] Phase 3: Target working directory support
  - Goal: Allow tool handoffs into a different existing directory.
  - Files: handoff tool/spawn helpers and tests.
  - Work: Add optional `cwd` resolution, relative/absolute handling, directory existence validation, and child session header cwd assignment.
  - Validation: Unit-test omitted, relative, absolute, missing, and non-directory paths.

- [ ] Phase 4: Child-generation bootstrap policy
  - Goal: Let tool-launched children generate and review their own handoff prompt.
  - Files: `extensions/session-handoff/metadata.ts`, `extensions/session-handoff.ts`, `extensions/session-handoff/extract.ts`, `extensions/session-handoff/review.ts`, tests.
  - Work: Extend bootstrap schema with activation policy, parent source session reference, and goal; implement child-side extraction, review, metadata-after-send, and cancel-prefill behavior.
  - Validation: Unit-test immediate-send compatibility and child-generate branches; manually smoke-test accept, edit, timeout, and cancel.

- [ ] Phase 5: Register `session_handoff` tool
  - Goal: Expose the background-only tool only when it can work.
  - Files: `extensions/session-handoff.ts`, tests, README if public docs are updated in the same unit.
  - Work: Conditionally register the tool under Ghostty/macOS, define schema and prompt guidelines, create child session, launch split, return child id/title/direction/cwd, and use `terminate` only if later testing proves it improves parent-agent behavior without hiding useful output.
  - Validation: Tool registration tests for Ghostty and non-Ghostty environments; tool execution tests for success and failure; `npm run check`.
