# Pi 0.80.6 Session and Transcript Modernization

## Status

Accepted

## Decision Summary

Pi Sessions moves its model-facing integration to Pi 0.80.6, adopts Pi's public CLI model resolver behind an authenticated-model guard, and supports the opt-in `max` thinking level through one local runtime definition. At the same time, handoff and messaging events gain deliberate transcript representations, handoff bootstrap state moves out of oversized shell environment payloads, resume commands become durably retrievable through launch receipts surfaced in the handoff board (design 18), and `session_ask` cancellation becomes coordinated rather than best-effort.

The central tradeoff is sharper semantic separation: child instructions are a model-visible **handoff kickoff**, parent command launches use a model-invisible **handoff launch receipt**, and successful sender evidence remains in the `session_send_message` tool row. These entries do not impersonate native user messages.

## Problem Statement / Background

The package currently straddles two generations of Pi behavior.

Pi 0.80.6 adds an opt-in `max` thinking level and publicly exports `resolveCliModel`, but Pi Sessions still carries multiple local model parsers and exact matchers. Those implementations do not preserve Pi's fuzzy aliases, slash-bearing model ids, or thinking-suffix behavior. `resolveCliModel` cannot be used unguarded: it intentionally searches `modelRegistry.getAll()` for CLI setup flows and may return a model without configured authentication or synthesize a custom model id. Nested work and in-process model switching have a stricter product invariant: only activated, authenticated models may run.

The handoff transcript also conflates domain events. An approved handoff currently enters the child as an ordinary user message even though it was generated and delivered by an extension. Conversely, a deferred `/handoff` leaves only a transient notification in the parent, even though its resume command is the most important recovery artifact. A background tool handoff has a tool-result row, but its rendering is sparse and does not share a clear contract with command-launched handoffs.

These are two different interfaces:

- The child receives model input: what work was handed off, by whom, and the exact approved prompt.
- The parent receives launch output: which child was created, how it was launched, and how to resume it.

Treating them as one card produces misleading metadata and poor copy ergonomics. They need separate names, persisted shapes, and renderers.

Manual copying is not a sufficient recovery interface. Pi TUI renderers produce visual terminal rows, and terminal selection commonly inserts newlines where long commands wrap. Pi exposes no copy-safe transcript block or row-local input handling. The current resume command makes this worse by embedding the complete base64 handoff bootstrap—including potentially the full approved prompt—in `PI_SESSIONS_HANDOFF_BOOTSTRAP`.

Cross-project handoffs also currently create the child file in the parent project's session directory and compensate with `--session-dir`. That contradicts the target cwd: a pi-librarian handoff launched from pi-sessions should be stored with pi-librarian.

Session messaging has a similar transcript gap. Successful sends already append `pi-sessions.message_sent`, but those entries have no renderer and persist too little target identity for a useful replayed view. Meanwhile, `session_ask` attaches an abort listener but starts expensive work before checking pre-abort, launches retries after cancellation races, and disposes while an unawaited nested abort may still be running.

This design supersedes the exact-only handoff model-resolution decision in design 15 and the native-first-user-message kickoff decisions in designs 02 and 08. The launch-backend seam, deferred backend, model inheritance, and review workflow from those designs remain valid. Design 18 renames the `detached` launch value to `deferred` (this document uses the new name throughout), replaces the `--copy-last`/`--list` surfaces with the handoff board, and builds tmux sub-agents on the receipts and bootstrap machinery defined here.

## Goals

- Depend on and verify Pi 0.80.6 before using its new public APIs.
- Support `max` everywhere Pi Sessions accepts, validates, formats, documents, or forwards thinking levels.
- Match Pi's model-reference behavior while guaranteeing nested work only uses authenticated, currently available models.
- Show useful `session_handoff` arguments while the model is still streaming them.
- Represent approved child instructions as a rich model-visible handoff kickoff without a duplicate user bubble.
- Represent every successful background handoff as useful parent-side launch output, including a durable deferred resume command.
- Make resume commands reliably copyable without depending on terminal selection.
- Store cross-project child sessions with their target project and remove arbitrarily large bootstrap payloads from launch commands.
- Render successful sent-message evidence without duplicating incoming-message UI.
- Make outer cancellation stop a nested `session_ask` promptly, exactly once, and without another attempt.
- Keep search, navigation, auto-title, and bootstrap behavior correct after the kickoff role changes.

## Non-Goals

- Making a handoff kickoff a native user message for `/tree`, fork, edit, first-user-prompt, or user-turn-count purposes.
- Adding compatibility rendering for old `pi-sessions.message_sent` entry shapes.
- Making automatic clipboard delivery durable or launch-critical. Clipboard writes remain best effort; their transient outcome is only available in the launching process.
- Adding focus or key handling to passive transcript rows. Copy actions live in the handoff board (design 18).
- Tmux launch backends and sub-agents. Design 18 owns them; this design supplies the receipts, kickoff, and bootstrap surfaces they build on.
- Adding an interactive handoff model picker.
- Changing incoming session-message replay or its existing model-visible renderer.
- Applying `max` to a model that does not support it. Pi and provider capability clamping remain authoritative.

## Exposed Shape

### Dependencies and thinking levels

The four Pi development dependencies move from `^0.80.2` to `^0.80.6`; peer minimums move from `>=0.80.2` to `>=0.80.6`. The lockfile resolves the Pi package family at 0.80.6 according to npm's normal package-lock format.

Pi 0.80.6 publicly exposes the `ThinkingLevel` type with:

```ts
"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
```

It does not publicly export its runtime all-level array or `isValidThinkingLevel` through the package root/export map. Pi Sessions therefore owns one runtime `THINKING_LEVELS` constant and one type guard. Tool schemas, settings parsing, and any remaining validation consume that single boundary.

### Authenticated CLI-style model resolution

A shared Pi Sessions resolver accepts:

```ts
{
  modelRegistry,
  modelPattern,
  thinkingLevel?
}
```

It calls Pi's public `resolveCliModel`, preserves its model-pattern and thinking-suffix behavior, and then requires the resolved `provider/id` to match a fresh entry from `modelRegistry.getAvailable()`. The available model object, not a synthesized or unauthenticated resolver object, crosses into nested execution or `pi.setModel()`.

Thinking precedence is:

1. explicit separate `thinkingLevel`
2. valid `:thinking` suffix returned by `resolveCliModel`
3. path-specific inherited/default thinking

A resolver warning remains attached to the resolution or resulting error. An unavailable result is never silently accepted merely because `resolveCliModel` found it in `getAll()`.

Path behavior remains distinct:

- Handoff override failure stops before draft generation and reports the available model list.
- `session_ask` falls back to the current model when its configured pattern cannot resolve to an available model.
- Auto-title walks its cheap-model fallback list, then the current model, when its configured pattern cannot resolve to an available model.

Model ids containing slashes or colons are not reparsed by Pi Sessions. Pi owns that grammar.

### `session_handoff` tool

The tool gains a required field:

```ts
title: string
```

Its description states that this short title becomes the child session's title and should summarize rather than repeat the full goal. For tool-launched handoffs, this title is authoritative: it labels the launch receipt, initial session entry, reviewed child, and final handoff metadata. Child extraction does not replace it with a second generated title.

The remaining model-related shape is:

```ts
model?: string
thinkingLevel?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
```

The separate `thinkingLevel` remains preferred, but Pi-compatible suffixes in `model` resolve correctly. Explicit `thinkingLevel` wins when both are present.

#### Live call rendering

`renderCall()` handles empty, malformed, partial, and complete streamed arguments through a pure view-model pass, a surface-specific presenter, and `ExpandableContentLayout`. It progressively displays `session_handoff`, launch target, authoritative title, and a one-row `CollapsibleText` goal. Resizing cannot turn the preview into an accidental second content row; hidden content is followed by the shared native-style expansion hint line. Unknown values remain pending rather than throwing or printing raw partial JSON.

On success, `renderResult()` updates that same layout instead of adding a second receipt block. A thin handoff-specific component composes the generic layout with the persistent command block and degraded-launch notice; the shared layout does not gain a speculative footer slot. Collapsed output adds the command beneath the one-row goal. Expanded output shows the complete goal plus labeled `session`, effective `model`, and conditional `cwd` metadata. The durable tool result is validated against the shared launch-receipt fields plus optional degraded direction and remains consumable by future user-session views.

### Handoff kickoff: child-side model input

The **handoff kickoff** is a model-visible custom message sent with:

```ts
sendMessage(message, { triggerTurn: true })
```

Its `content` is exactly the approved handoff prompt, so provider context is unchanged. Its `details` carry renderer metadata:

```ts
{
  source: {
    sessionId: string
    sessionName?: string
  }
  title: string
}
```

The renderer uses a Pi custom-message shell. Collapsed and expanded views both show the complete approved prompt beneath the label, child title, and `from <parent title> (<full parent UUID>)` source identity (or the UUID alone when untitled). The kickoff represents the instructions delivered on the user's behalf, so hiding or substituting any part of that prompt would be misleading. Expansion intentionally does not alter this entry.

The originating goal remains internal handoff metadata and is not duplicated into newly written kickoff details. Extracted context is supplementary evidence rather than a second task. The renderer does not show child id, cwd, launch target, model, or resume command. Those are launch output owned by the parent receipt.

All accepted kickoff paths use this message:

- plain in-process `/handoff`
- immediate bootstrap in a split or deferred command child
- reviewed child-generated `session_handoff`

No ordinary user message duplicates it.

The custom role remains semantically distinct:

- it is searchable as custom-message content
- session navigation represents it explicitly as a handoff
- bootstrap freshness treats an existing kickoff as already started
- `firstUserPrompt`, native user-turn counts, and native message counts do not pretend it was typed by a user
- it does not appear in `/tree`'s user-only filter
- it cannot serve as a native first-user fork/edit anchor

The child still receives an explicit session title and durable handoff metadata, so those native-role limitations do not leave it unidentified.

### Prepared child persistence and bootstrap consumption

The child session file owns its pending bootstrap. The launch command no longer carries `PI_SESSIONS_HANDOFF_BOOTSTRAP`.

Pi 0.80.6 intentionally defers writing a new `SessionManager` until an assistant response exists, so an extension cannot create a discoverable pre-seeded child using append methods alone. Pi Sessions uses the public manager to construct valid in-memory state—header, ids, parent linkage, title, and bootstrap entry—then performs one explicit initial JSONL flush to the manager's computed session file. It does not hand-assemble those entry relationships independently.

The pending entry is model-invisible and stores the existing immediate or child-generated bootstrap schema. Consumption is append-only:

- a handoff kickoff carrying that bootstrap entry id proves accepted delivery
- cancel, prefill, stale user input, or invalid bootstrap appends a consumed marker referencing the bootstrap entry
- a bootstrap with neither proof remains pending
- a crash during review therefore offers review again on the next resume

The startup hook scans the current branch for the newest unconsumed pending bootstrap. Environment state is no longer part of bootstrap discovery.

Pi restores session model/thinking only when the existing session has context messages. A model-invisible bootstrap does not satisfy that condition, and adding a fake custom message would contaminate model context. The canonical resume command therefore retains `--model provider/id:thinking`; model/thinking entries alone are not used as a startup workaround.

### Target-owned child session storage

For a same-cwd handoff, child creation preserves the parent's session directory, including a deliberate nondefault directory. For a cross-cwd handoff, Pi Sessions calls `SessionManager.create(targetCwd)` without the parent directory so Pi computes the target project's default storage location.

The resume command includes `--session-dir` only when the created child actually uses a nondefault session directory. A normal cross-project command is therefore shaped like:

```sh
cd <target-cwd> && pi --session-id <uuid> --model <provider/id:thinking>
```

This aligns storage, cwd, indexing, and copied recovery commands.

### Handoff launch receipt: parent-side launch output

The **handoff launch receipt** describes a successful background launch in the parent transcript.

Ownership depends on invocation:

- `session_handoff` uses its existing durable tool-result row and `renderResult()`.
- `/handoff --deferred` and `/handoff --left|--right|--up|--down` append a model-invisible custom entry after successful launch.
- Plain in-process `/handoff` has no surviving parent transcript and appends no launch receipt.

Both surfaces consume the same strict durable receipt contract, command component, and deferred-command labeling. Their summary presentation intentionally differs: the command-owned custom entry is a standalone launch receipt, while the tool result updates its streamed call card and retains the goal. They never produce duplicate rows. Pi supplies the outer success box for the tool result; the command-owned custom entry uses the same `toolSuccessBg` treatment itself. Successful launches do not also emit transient notifications; errors, cancellation, and terminal identification still do.

The view model contains:

```ts
{
  sessionId: string
  childSessionFile: string
  title: string
  launch: "deferred" | "left" | "right" | "up" | "down"
  resumeCommand: string
  cwd?: string
  model: string
}
```

`childSessionFile` is required so the User sessions board can read startup evidence directly without scanning project sessions. Receipts without it are invalid. `cwd` is present only when the effective target cwd differs from the parent cwd. `model` always records the effective child model/thinking, including when it matches the parent. Design 18 also extends the launch vocabulary with `subagent`.

#### Deferred receipt

Collapsed:

- `handoff ready <title>`
- effective child `model`
- a `resume command` label followed by the full command in a shaded, borderless block

Expanded places metadata before that same command block, in this order:

1. `id`
2. conditional `cwd`
3. effective child `model`
4. `resume command` and the full command

When automatic copying runs, the launching process annotates the label with `· copied to clipboard` or `· clipboard copy failed`. The outcome lives only in extension memory: it survives transcript rerenders such as `Ctrl+O`, but is absent after reload and never enters the receipt schema. Disabled copying has no annotation. Clipboard failure does not fail the handoff because the command is visible in the durable receipt.

#### Split receipt

Collapsed:

- `handoff launched <title>`
- direction and child id
- effective child `model`

Expanded adds metadata in this order:

1. `id`
2. `launched` as backend and direction, for example `Ghostty right`
3. conditional `cwd`
4. `recovery command` and the full resume command in the same shaded, borderless block

#### Self-locating resume commands

The resume command is the canonical recovery artifact consumed by launch backends, failure messages, clipboard delivery, and renderers. When effective target cwd differs from parent cwd, it begins with a shell-quoted:

```sh
cd <target-cwd> && ...
```

No prefix is added when both cwd values are equal. This makes copied commands reproduce the launch context without depending on the terminal's current directory.

### Reliable handoff command retrieval

Pi has no transcript component whose selected text differs from its visual rows. `Text` and `Markdown` wrap into terminal lines, and tool/message/entry renderers are passive. The full command remains visible as useful evidence, but terminal selection is not the supported correctness path.

Explicit copy actions use Pi's public `copyToClipboard()` and live in the handoff board (design 18), whose User sessions tab normalizes directional and deferred command receipts plus `session_handoff` tool results into the shared launch-receipt view model, across all branches, newest first; subagent receipts stay solely in the operational roster. The source is the session transcript rather than the index, so branching, compaction, or index freshness cannot hide a launch that actually occurred. This design contributes the durable receipts and the shared view model; the board's layout, keys, and empty states are design 18's scope.

### Sent session-message tool receipt

The successful `session_send_message` tool row is the sender receipt. No separate custom sent entry is appended. Its result details enrich the durable tool result with the target endpoint and relation; the tool-call arguments already own the message body and response-request intent.

`renderResult()` updates the existing call component instead of adding a second block. Collapsed output identifies successful delivery by target title or UUID, relation, and response-request intent, followed by the first three rendered message rows. Text wraps naturally at the terminal width supplied to `render(width)`, and wrapped portions of an earlier logical line consume the same three-row budget. Remaining rendered content is represented on a separate `(N more lines, M total, <key> to expand)` hint line, where `<key>` comes from Pi's live `app.tools.expand` binding. Expanded output adds labeled `session <uuid>` metadata and shows the full message body.

`pi-sessions.message_received` remains receiver-side replay bookkeeping, and the existing model-visible incoming custom message remains the only incoming-message UI. Its collapsed body uses the same width-reactive, naturally wrapped three-rendered-row behavior as the sender tool; expanded mode shows the complete received message.

Sender and receiver messaging surfaces use the shared rendering boundary. `CollapsibleText` owns width-aware wrapping, collapsed rendered-row limits, expansion, remaining/total counts, and the separate native-style hint line. It resolves Pi's live `app.tools.expand` binding itself, so presenters provide only text and a collapsed-row budget while user keybinding overrides appear consistently. `ExpandableContentLayout` composes a header, always-visible metadata, expanded metadata, and optional collapsible body without owning an outer frame. Pure view-model passes normalize streamed arguments, durable tool-result details, or received-entry data; surface-specific presenters apply wording and theme into the generic layout contract. Tool execution, message data, presentation, and TUI rendering therefore remain separate. Pi continues to own the outer sender tool shell, while the incoming custom-message adapter composes the same layout inside an ordinary Pi `Box`; no wrapper around `Box` is introduced.

### `session_ask` cancellation

The outer tool's `AbortSignal` owns nested cancellation.

- An already-aborted signal stops before session navigation loading, resource loading, or `createAgentSession()`.
- Once a nested session exists, the first abort starts exactly one `session.abort()` promise.
- The current prompt and nested abort are coordinated; cancellation is checked before and after every attempt.
- No later attempt starts after cancellation.
- Cleanup removes the listener, awaits the in-flight abort, and calls `dispose()` exactly once.
- Standard abort/cancellation semantics propagate to Pi. The tool does not replace cancellation with a generic successful fallback or `Session ask was cancelled` error.

Normal missing-answer behavior remains unchanged when no abort occurred. Progress details require question and complete session identity; completed details additionally require answer and relevant-file evidence, with only the debug path optional. Completed answers use the shared view-model → presenter → `ExpandableContentLayout` boundary with a six-row `CollapsibleText` body, so wrapped text respects the budget as the terminal resizes and uses the same live expansion hint. The partial `Reading session...` state remains a specialized renderer because it represents progress rather than completed expandable content.

### Auto-title thinking

Auto-title generation continues to use `completeSimple` directly with a 64-token cap rather than creating a nested AgentSession. Its already-parsed `sessions.autoTitle.thinkingLevel` becomes effective:

- `off` omits the provider reasoning option
- other levels, including `max`, pass through as `reasoning`
- an explicit setting overrides a valid thinking suffix on the configured model

This does not change the configured-model fallback chain.

## Design Decisions

### 1. Reuse Pi's public resolver, then narrow its result

Duplicating Pi's model grammar has already lost behavior around fuzzy aliases, slash-bearing ids, and thinking suffixes. `resolveCliModel` is the canonical public parser/resolver in 0.80.6 and should own those rules.

Its `getAll()` behavior is correct for a CLI that may receive an API key during startup, but wrong for nested extension work. Matching the result back to `getAvailable()` preserves both interfaces: Pi-compatible resolution and Pi Sessions' authenticated-only invariant.

### 2. Keep one local runtime thinking-level list

The public package exposes the `ThinkingLevel` type but not the runtime validator/list used by Pi's CLI. Importing `dist/cli/args` would cross the export map and bind the extension to private layout. One named local list is less risky than a private import and eliminates the current duplication. It must be tested against `max` and used everywhere runtime enumeration is unavoidable.

### 3. Make the tool-supplied title authoritative

A background tool receipt must have a useful label before the child generates or reviews its draft. Updating an immutable parent receipt later would add cross-session synchronization for cosmetic state.

The caller therefore supplies a required concise title, explicitly documented as the child's title. Command handoffs have no separate title argument, so they use the first 64 characters of the submitted goal.

### 4. Separate kickoff input from launch output

The handoff kickoff answers, “What instructions did this child receive?” The launch receipt answers, “What child did the parent create, and how can it be reached?” Combining them caused the original mockup to show source-session input beside unrelated operational output.

Separate entries make model visibility, transcript location, and metadata ownership obvious. The resume command never appears in the child kickoff. The approved prompt never needs to appear in the parent launch receipt.

### 5. Use a custom message for generated child input

The handoff prompt is generated, reviewed, and injected by an extension. A native user role inaccurately suggests it was typed by the user and forces the transcript to render a large ordinary prompt bubble. Pi already converts model-visible custom messages into provider-user context, so a custom message preserves model behavior while enabling a compact semantic card.

The cost is accepted: Pi core's user-only tree and native fork/edit anchors do not include the kickoff.

### 6. Keep kickoff-derived metadata role-honest

Search should index the kickoff and session navigation should identify it, but native user fields should remain native. Special-casing the kickoff into `firstUserPrompt` or user-turn counts would make stored role and derived role disagree.

Bootstrap replay prevention is different: it asks whether the handoff has already started, not whether a human typed. It therefore recognizes both native user input and an existing handoff kickoff.

### 7. Render one launch view model through two transcript mechanisms

Tool calls and commands have different durable transcript mechanisms. A tool result is already persisted and should not append a second custom receipt. A command has no tool row and needs a custom entry if its resume command is to survive beyond a notification.

Sharing the durable contract and command primitives prevents operational details from drifting without forcing the standalone command receipt and streamed tool card into one summary layout.

### 8. Keep deferred commands visible when collapsed

A deferred handoff's primary output is the command. Hiding or truncating it behind expansion defeats the flow's recovery and copy purpose. The command therefore remains full and selectable in collapsed mode; expansion only adds conditional metadata.

A split launch differs because the child is already running. Its command is recovery detail and belongs in expanded mode.

**Amended by design 18, Phase 9:** `/handoff` is board-only and command launches no longer exist. The `session_handoff` tool result is the sole launch receipt and the User sessions tab's persistent data and copy surface.

### 9. Make resume commands self-locating

A command copied in the parent may be pasted from another directory. Prefixing `cd` only when the target differs preserves concise common-case output while making cross-project handoffs reproducible. The same canonical string must be used by backends, clipboard, errors, and renderers so no “display command” diverges from the launch command.

### 10. Persist bootstrap state, but retain the startup model argument

Moving bootstrap into the child session removes an unbounded environment payload and makes pending work durable. Pi's deferred first write means one manual flush remains necessary; using `SessionManager` to construct entries keeps that workaround at the persistence boundary rather than duplicating Pi's session model. The submitted goal is the destination `Task` for every generated handoff. Extraction contributes only supplementary context, relevant file paths, and open questions; it does not synthesize or persist a competing task. Human review may still edit the assembled prompt before launch.

Pi's initial model restoration still requires context messages. Retaining `--model` is preferable to injecting a fake message or importing more startup internals.

### 11. Let target cwd own cross-project storage

A child session belongs to the project it will operate in. Reusing the parent session directory made index location and cwd disagree and forced every cross-project command to carry `--session-dir`. Pi's own target-derived default is the canonical association.

Same-project custom session directories remain intentional and are preserved.

### 12. Make programmatic copy authoritative, not terminal selection

There is no safe renderer-only fix for newline insertion during terminal selection. Explicit `copyToClipboard()` calls preserve the canonical string regardless of wrapping; the handoff board is the surface that exposes them.

Receipt reads scan the full session tree because branching changes conversation context but does not undo an externally created child session.

### 13. Report automatic clipboard outcome only while it is known

The durable command is authoritative. Automatic clipboard placement may succeed or fail based on platform state and does not change launch success or the persisted schema. The launching extension instance may annotate its receipt with the actual outcome, but that ephemeral evidence disappears on reload. A missing annotation therefore means unknown or disabled, not failure. Explicit board copy actions report their own outcome. No clipboard field appears in the receipt.

### 14. Let the sending tool own sender evidence

A successful tool call is already durable evidence. Appending a second custom sent entry duplicates the same event and makes the transcript noisier. The tool result therefore stores the target endpoint and relation needed for deterministic rendering after restart, while the existing tool-call arguments supply the body and response policy.

### 15. Coordinate abort before disposal

Calling `void session.abort()` makes cleanup race the operation it is meant to stop. Cancellation is a lifecycle, not a notification: start abort once, await it, stop retries, remove listeners, then dispose. Standard AbortError propagation lets Pi present cancellation as cancellation rather than extension failure.

## Edge Cases & Failure Modes

- **Pi exposes no public runtime thinking validator:** use the single local list; do not import private package subpaths.
- **`resolveCliModel` returns a custom or unauthenticated model:** reject it when no equal fresh `getAvailable()` model exists.
- **Resolver returns a warning plus an available model:** retain the warning according to the calling path while using the authenticated available object.
- **Both model suffix and separate thinking are provided:** separate thinking wins.
- **`max` is unsupported by the chosen model:** pass the requested value to Pi/provider boundaries that accept it; normal capability clamping applies.
- **Available models change after the handoff tool description snapshot:** execution resolves against the live registry and errors before draft generation if unavailable.
- **A partial handoff call contains wrong types:** stringify only safe recognized values; show pending/unknown state and never throw from rendering.
- **Replacement session callback uses stale extension objects:** use only `ReplacedSessionContext.sendMessage()` inside `withSession`.
- **Bootstrap environment is replayed after kickoff:** existing kickoff counts as started and prevents duplicate delivery.
- **Custom kickoff is absent from `/tree` user-only view:** documented limitation; session title and normal all-entry transcript still identify the handoff.
- **Parent session has no title:** kickoff source line uses the full parent UUID without an empty title.
- **Deferred target cwd differs:** command receives a shell-quoted `cd ... &&` prefix and expanded metadata includes cwd.
- **Cross-project target:** the child file is created in the target project's default session directory; the command normally omits `--session-dir`.
- **Same-project nondefault session directory:** preserve the directory and include `--session-dir` because target-derived discovery would not find it.
- **Pending bootstrap is reviewed and process crashes:** without kickoff proof or a consumed marker, review appears again on resume.
- **Pending bootstrap is cancelled, prefilled, stale, or invalid:** append a consumed marker so startup does not repeat it.
- **Target model equals current model:** model metadata still shows the effective child model/thinking so every receipt is self-describing.
- **Automatic clipboard copy fails:** handoff succeeds; the launching process shows the transient failure and the durable command remains visible. Clipboard status is not persisted.
- **Explicit board copy fails:** keep the failure visible and do not claim the clipboard changed.
- **Launch entry is on an abandoned branch:** it remains listable because the child launch was an external side effect.
- **Split launch fails after session creation:** error includes the same self-locating resume command; no success receipt is appended.
- **Historical custom sent-message entry:** no renderer is registered, so it contributes no duplicate sender UI.
- **Target session is missing from the index during send:** tool-result details retain the endpoint UUID without optional title/cwd; delivery itself remains broker-authoritative.
- **Signal is aborted before nested session creation:** throw standard cancellation without allocating the nested session.
- **Signal aborts during an attempt:** await nested abort, start no further attempt, remove listener, dispose once.
- **Nested prompt fails normally while signal is not aborted:** preserve normal error behavior rather than misclassifying it as cancellation.

## Alternatives

### Continue exact-only handoff model matching

- **Status:** Rejected
- **Decision:** Pi's public resolver is now explicitly required across handoff, session-ask, and auto-title. One authenticated guard addresses the risk that originally motivated exact-only matching.
- **Discussion:** Design 15 preferred a visible retry over a fuzzy wrong-model launch. That avoided silent mistakes but diverged from Pi's aliases and model-id grammar. Matching the resolved result back to `getAvailable()` supplies the missing safety boundary.

### Import Pi's internal `isValidThinkingLevel`

- **Status:** Rejected
- **Decision:** The symbol is not exported through the package root or export map. Private-path imports are less stable than one centralized local runtime list.
- **Discussion:** If Pi later exports a canonical public list or validator, replace the local boundary.

### Keep the kickoff as a native user message

- **Status:** Rejected
- **Decision:** It misstates authorship and prevents the requested semantic renderer. Provider context equivalence is available through model-visible custom messages.
- **Discussion:** Native `/tree` and fork/edit behavior would be convenient, but those are Pi-core limitations rather than reasons to preserve the wrong role.

### Put launch metadata into the child kickoff

- **Status:** Rejected
- **Decision:** Session id, cwd, launch backend, model override, and resume command are parent-side launch output. Mixing them into child input conflates two events.
- **Discussion:** The child can obtain its ordinary session context elsewhere; the kickoff should explain what it was asked to do.

### Append a custom launch receipt for tool calls too

- **Status:** Rejected
- **Decision:** The durable tool result already owns that output. Appending another entry creates duplicate rows and competing expansion state.
- **Discussion:** Command paths append a custom entry only because they have no tool-result transcript row.

### Hide the deferred command until expanded

- **Status:** Rejected
- **Decision:** The command is the deferred flow's primary result and must remain immediately selectable.
- **Discussion:** Split commands remain expanded-only because they are recovery artifacts rather than the normal next action.

### Create a copy-safe transcript block

- **Status:** Rejected
- **Decision:** Pi renderers cannot attach canonical selection text to visual rows, and terminal selection owns wrapped-line newline behavior.
- **Discussion:** Shell continuation characters are not reliable because TUI padding or copied trailing spaces can invalidate the continuation. Programmatic clipboard actions are the safe interface.

### Keep bootstrap in `PI_SESSIONS_HANDOFF_BOOTSTRAP`

- **Status:** Rejected
- **Decision:** The payload grows with the approved prompt and makes rendered/copied commands arbitrarily large. Persist bootstrap state in the child session instead.
- **Discussion:** One manual initial flush remains because Pi 0.80.6 intentionally defers writing sessions without assistant messages.

### Persist model/thinking entries and remove `--model`

- **Status:** Rejected
- **Decision:** Pi restores model/thinking only when the session already has context messages. A pending custom entry does not qualify, and a fake custom message would contaminate model context.
- **Discussion:** Retaining the compact `--model provider/id:thinking` argument stays within Pi's supported startup interface.

### Dedicated `--copy-last` and `--list` command surfaces

- **Status:** Rejected
- **Decision:** Both surfaces were replaced by the handoff board (design 18) before implementation. Bare `/handoff` opens the board; copy actions live in its User sessions tab.
- **Discussion:** `--copy-last`'s meaning became ambiguous once attach and resume commands coexist for sub-agents, and a management modal was needed regardless. Shortcuts can return when usage patterns earn them.

### Store cross-project children in the parent session directory

- **Status:** Rejected
- **Decision:** It makes cwd and storage ownership disagree and forces `--session-dir` into otherwise default commands.
- **Discussion:** Same-project handoffs still preserve an explicitly nondefault parent directory.

### Persist a separate sent-message receipt

- **Status:** Rejected
- **Decision:** The successful `session_send_message` tool row is the sender receipt.
- **Discussion:** A second custom entry duplicated the tool call and made the transcript noisier without adding durable evidence.

### Return a generic session-ask cancellation error

- **Status:** Rejected
- **Decision:** Cancellation should retain Pi/AbortSignal semantics and must not look like a normal tool failure or missing answer.
- **Discussion:** The previous message was readable but hid lifecycle races and could be emitted after another nested attempt began.

## Implementation Plan

Implemented jointly with design 18. The combined phased plan lives in [18-tmux-subagents.md](18-tmux-subagents.md#implementation-plan); phases 1–8 cover this design's scope.
