# Tmux Sub-Agents, Revised

## Status

Draft

Supersedes `18-tmux-subagents.md` (whose implementation is discarded; the doc will be deleted and this file renamed after cleanup). Builds on designs 15 (launch-backend seam), 16 (prepared-child bootstrap persistence, kickoff entries, launch receipts and their shared view model), and 17 (source snapshots) — all implemented at the baseline commit (`845739b`).

## Decision Summary

Pi Sessions gains sub-agents: disposable child sessions that carry **exactly one task for their entire life**, run in detached tmux windows while busy, and exist only as session files while dormant. Three structural decisions replace the first design 18: the package advertises **one extension entrypoint** wired by a composition root (deleting cross-extension event seams and process globals), lifecycle observation becomes **trigger-only reconciliation** (deleting the background monitor), and completion becomes an explicit **report** — a dedicated turn-terminating tool whose durable child record is the source of truth and whose parent receipt is durable before acknowledgment.

The central tradeoffs: single-obligation children cannot be re-tasked (launch a new child instead — they are disposable by design); trigger-only reconciliation accepts staleness between interaction points; and the single entrypoint trades per-extension enablement in Pi's extension list for feature toggles in settings. Backwards compatibility is explicitly not a constraint.

## Problem Statement / Background

The first design 18 was implemented end to end and failed structurally, not superficially. A post-implementation architecture review (conducted against a clean checkout, with an incident-derived threat model) identified the load-bearing mistakes:

- **Cross-extension coordination through event-bus seams.** The "dormant-target resolver" and "cancel-provider" seams let messaging call up into sub-agent logic — a runtime dependency cycle wearing an event-bus costume, with the early-listener/unready-service failure modes that come with it. The `active.ts` process global for sharing one broker connection across jiti module graphs was the same disease in another organ: pi loads each advertised entrypoint in an isolated module graph (`moduleCache: false`), so seven entrypoints forced globals and discovery protocols for what ordinary imports and constructor injection do in one graph.
- **A 1-second tmux polling monitor.** It existed to keep derived state warm. Nothing correctness-critical consumes that freshness; every read surface can reconcile on demand.
- **No obligation semantics.** With completion inferred from ordinary messages, a historical interim message could satisfy a later completion expectation, and `requestResponse` was frozen at bootstrap with nothing to scope it to. Observed bugs followed exactly this shape.
- **Auto-continue on restore.** Machinery that restarts crashed children at every reconciliation point is a crash loop with extra steps, and required ephemeral retry bookkeeping to bound.

The surrounding machinery this design composes already exists and survives: handoffs create context-rich child sessions (designs 02/08/15/16/17), the message broker routes between live sessions (designs 10/12), lineage lives in the session index, and `session_ask` interrogates any transcript. The two driving failure scenarios from the first design remain the right ones:

- _The forgotten pane_: orphaned pi processes accumulating in tmux sessions the user never sees.
- _The lost report_: a worker finishing while its parent is closed, its result with nowhere to go.

## Goals

- A parent session delegates focused, disposable work to background children on its own initiative, without occupying the user's terminal.
- Every advertised capability composes from independently coherent features: handoff and messaging remain fully functional primitives; sub-agents are a composition, not a rewrite.
- The user and the agent can always see what was spawned, what is running, and what stopped — after crashes, rewinds, quits, and manual tmux interference.
- Closing a parent never leaks running workers; resuming it revives exactly the workers the active branch says should exist.
- A child's report reaches its parent durably, including when the parent is closed at report time.
- One broker client per pi process, one module graph, no process globals, no cross-extension discovery protocols.

## Non-Goals

- Re-tasking a child. One task per sub-agent, for life. New work means a new child.
- A synchronous fan-out/join primitive. Parents delegate and continue.
- Warm idle processes. Wake latency is paid per exchange by design.
- Automatic restart of crashed or interrupted children. Recovery is explicit (a message wakes them).
- Managing grandchildren directly. Each session manages one generation; deeper control is delegated recursively.
- Concurrent parent processes (the same parent session open in two pi processes). The broker's duplicate-registration rejection makes the second process loudly inert; stated, not solved.
- Non-tmux sub-agent substrates.
- Backwards compatibility of any kind: extension lists, settings shape, index schema, and durable entry types may all change; a reindex is assumed.

## Exposed Shape

### Vocabulary

- **Sub-agent**: a child session created by a handoff for delegated background work. **Busy** (stamped tmux window exists) or **dormant** (no process; the session file is the sub-agent).
- **Task**: the single obligation a sub-agent carries from birth — its handoff kickoff. Never replaced.
- **Report**: a durable child-authored record delivered to the parent via `report_results`. The **first report on the child's active branch satisfies the task obligation**; later reports answer follow-ups.
- **Steering message**: an ordinary message into a busy child's current turn. Creates no obligation.
- **Follow-up**: an ordinary message to a dormant completed child (wakes it); the child answers with another report and exits again. Completion never regresses.
- **Ledger**: writer-scoped lifecycle entries in the parent's session file (launched / cancelled / suspended / closed / report-received). The **desired set** is reconstructed by walking the active branch from the current leaf.
- **Reconciliation**: the single idempotent operation that converges tmux runtime to the ledger's desired set and recovers missed reports. Trigger-only, single-flight, plan-then-apply.

### Package entrypoint and composition root

`package.json` advertises exactly one extension:

```jsonc
"pi": { "extensions": ["./extensions/pi-sessions.ts"] }
```

The root loads settings, constructs features as plain install functions in dependency order, and wires them by constructor parameters. No feature discovers another; disabled features are `undefined` parameters, checked loudly:

```ts
const index     = installIndex(pi, settings);
const messaging = settings.features.messaging ? installMessaging(pi, { index }) : undefined;
const subagents = settings.features.subagents && messaging
  ? installSubagents(pi, { messaging, index })   // → { launchTarget, roster, classify }
  : undefined;
installHandoff(pi, { index, launchTargets: subagents ? [subagents.launchTarget] : [] });
installSearch(pi, { index, messaging, roster: subagents?.roster });
installAsk(pi, …); installAutoTitle(pi, …); installHooks(pi, …);
```

The root also owns lifecycle ordering: it subscribes to `session_start`/`session_shutdown` once and drives feature hooks deterministically — broker registration resolves before any reconciliation mutation. A process that fails broker registration (duplicate session) refuses all reconciliation mutation, not merely messaging.

Which tool registrations happen is a root decision: with sub-agents enabled, the composite `session_send_message` (wake-on-send) and `session_cancel` (ownership dispatch) register instead of messaging's plain variants, and they call _down_ into the messaging handle. No upward calls exist anywhere.

Settings move under `sessions.features` (booleans, default on) and `sessions.subagents` (`maxDepth`, default 2, user-settable).

### `session_handoff` tool

```ts
launch: "left" | "right" | "up" | "down" | "deferred" | "subagent";
```

- Direction values remain user-directed visible splits, environment-resolved (`$TMUX` before `TERM_PROGRAM`; tmux split inside tmux, Ghostty otherwise).
- `subagent` is the agent's to use freely. Present in the schema only when the tmux binary exists and the session's durable depth is below `maxDepth` (registered once at `session_start`; depth is fixed per session).
- `requestResponse` defaults to `true` for `launch: "subagent"` only; fire-and-forget must be explicit.
- Launch failure after child preparation reports the surviving prepared session and its resume command; it never pretends nothing was created.
- Handoff context anchors to the last settled parent entry, never the in-flight tool-call leaf. The tool is not marked `sequential`.
- Command and tool paths (`/handoff --subagent`, `launch: "subagent"`) share one launch/bootstrap policy; policy booleans are persisted in the prepared child, never defaulted per path.

### `report_results` (child-side tool)

Available to sub-agent children for their whole life (identity self-check gates it; see Design Decision 8). Semantics: _report to parent_.

1. Append the durable child report record (`reportId`, `status: done | error`, report body) — the child file is the mailbox of record.
2. Attempt delivery as a typed `subagent_report` envelope. Success is not required.
3. Terminate the turn (analogous to session-ask's `provide_results`).
4. Exit at settle (or linger while observed).

The first report on the active branch satisfies the task obligation. Subsequent reports answer follow-ups with identical mechanics. Identical schema whether or not the parent is reachable — delivery is replication of an already-durable record.

### `session_send_message` (composite when sub-agents are enabled)

Routing, decided before transport:

1. Target broker-live → ordinary send (steering, follow-up, or peer message — no distinction needed at transport level).
2. Owned dormant child → **wake-on-send**: reconcile-aware materialization (respawn window, bounded wait for broker registration, verified kill-and-respawn once on timeout), then ordinary send. A message to a `stopped` child is the explicit supersession of its cancellation. A message to an `interrupted` child is the explicit restart.
3. Unknown dead target → plain error.

This is also the agent's recovery surface: the roster shows `interrupted`/`stopped`; sending is restarting. No dedicated continue/retry tool exists.

### `session_cancel`

```ts
session_cancel(sessionId);
```

- Owned sub-agent → durable cancellation ledger entry **first**, then live-cancel envelope if broker-registered (covers external resumes), then verified tmux kill. Unverified teardown reports `stopping`, never `stopped`.
- Other broker-live session → cancel envelope; the target's runtime calls `ctx.abort()`. Guidance: only against user sessions when the user directs it.
- Anything else → error; nothing to cancel.

Owned-managed is checked before broker-liveness because aborting a turn does not remove a managed process; cancellation must converge both.

### `session_search`: a selector over three evidence planes

```ts
{
  query?, files?, cwd?, repo?, time?, sort?, limit?,   // content (SQLite index)
  kind?: "user" | "subagent",                          // content facet (from SessionOrigin)
  live?: boolean,                                      // presence (broker ∪ managed tmux windows)
  relation?: "subagents",                              // relationship (transcript truth; extensible)
  relationScope?: "branch" | "tree",                   // vantage; default "branch"; valid only with relation
}
```

Engine contract: relationship and presence planes resolve to session-id sets **outside** the index (relationship from transcript ledger walks — never from indexed classification); the content plane filters and ranks within the intersection (the existing `includeSessionIds` mechanism, promoted from `live:`'s special case to the tool's core).

- `relation: "subagents"` = the transitive closure of writer-scoped sub-agent launch records: the parent's active branch yields owned children; each child's active branch yields grandchildren. Rows carry derived state, depth, and `onActiveBranch`; responses carry scope totals (`matched: 0, total: 6` is distinguishable from `total: 0`).
- `relationScope: "tree"` widens the ledger walk to all branches (fork copies still excluded by writer scoping) — "sub-agents this session ever launched," for history and forensics.
- `live: true` with a relation scope means managed runtime liveness: a stamped tmux window counts immediately, before broker registration; an externally resumed broker-live child also counts.
- Relation-scoped reads trigger reconciliation (freshness over read purity; bounded, single-flight, documented as mutating).
- `SessionOrigin` gains `subagent` (inferred from the sub-agent marker in handoff metadata). Index schema version bumps; full reindex assumed.

### `/handoff` board

Bare `/handoff` opens the **Handoffs** board: **Subagents | History** tabs. Visual contract: the preserved mockups in `docs/designs/18-tmux-subagents/` (quiet aligned grid, first-column-only indentation, bordered Details pane, display-width-aware columns). Actions derive from state — stop with inline confirm on running rows, copy-observe on busy rows, copy-resume only where nothing is live. History spans all branches deliberately; the roster is branch-scoped. Successful sends and launches stay quiet in the transcript; a recovered report surfaces as one dim system line (`[system] subagent <child short-id> has result available`), injected only at a reconciliation point.

### Tmux topology

Per-parent tmux session `pi-<parent-id-prefix>` (8+ hex chars) on the default server, created on demand, dying naturally with its last window. One window per busy child, named from the handoff title, stamped with a `@pi_session_id` window option carrying the full child session id. `tmux list-windows -F` over stamped options is the live roster query; window identity is runtime evidence, derived fresh, never persisted. A missing per-parent session is an empty window set, not an error. Sub-agent placement ignores the user's tmux context — always the detached per-parent session; observation is `switch-client` inside tmux, `attach` outside. Resume commands are persisted as exact safely-quoted strings (they encode cwd, session dir, id, model, thinking level — not reconstructable from the file path).

### Durable records

All coordination state is session-file truth. The SQLite index only filters, ranks, and decorates after ownership is resolved from transcripts. Every ledger entry carries the writing session's id (`writerSessionId`); entries written by another session are ignored (fork safety). **Outcome** decisions read the active branch via `SessionManager`, never raw JSONL order.

| Record (customType)                     | File                             | Written by                                                                               | Content / notes                                                                                                                                                                                                                                                                        |
| --------------------------------------- | -------------------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pi-sessions.subagent`                  | child (prewritten before launch) | launch target                                                                            | identity: `{childSessionId, ownerSessionId, parentSessionFile, depth}`. Gates all child-side sub-agent behavior only when `childSessionId === currentSessionId` — a fork copies it but fails the self-check and behaves as an ordinary session.                                        |
| `pi-sessions.subagent_launched`         | parent                           | launch target                                                                            | ownership: `{childSessionId, childSessionFile, title, goal, requestResponse, model?, cwd, resumeCommand, depth}`. The ledger walk's source.                                                                                                                                            |
| `pi-sessions.subagent_report`           | child                            | `report_results`, **before** delivery                                                    | `{reportId, status: done \| error, report}`. First on active branch = completion.                                                                                                                                                                                                      |
| `pi-sessions.subagent_report_received`  | parent                           | sub-agents' typed incoming handler (**before** broker ack) or reconciliation (recovered) | `{childSessionId, reportId, status, report, provenance: live \| recovered}`. The only parent record per report; deduped by `reportId` (readers fold duplicates; append-only files cannot check-then-append). `childSessionId` comes from the broker-stamped source, never the payload. |
| `pi-sessions.subagent_closed`           | child                            | system, at settle                                                                        | obligation closure without a report: `{reason: "no_response_expected" \| "no_report_after_reminder"}`. Lets fire-and-forget complete durably and bounds the reminder policy.                                                                                                           |
| `pi-sessions.report_reminder`           | child                            | system, at first reportless settle                                                       | durable one-shot marker; no re-reminding after restarts.                                                                                                                                                                                                                               |
| `pi-sessions.subagent_cancelled`        | parent                           | composite cancel, **before** any kill                                                    | `{childSessionId}`. Idempotent intent; superseded by a later wake message.                                                                                                                                                                                                             |
| `pi-sessions.subagent_suspended`        | parent                           | shutdown teardown (non-reload reasons)                                                   | `{childSessionIds: [...]}`. Distinguishes expected suspension from a crash; drives auto-restore.                                                                                                                                                                                       |
| `pi-sessions.subagent_ownership_closed` | parent                           | reconciliation                                                                           | `{childSessionId, reason}`. Closes ownership after confirmed completion/closure discovery.                                                                                                                                                                                             |
| `pi-sessions.subagent_disowned_notice`  | fork                             | fork's first reconciliation, one-shot                                                    | model-visible note: copied sub-agent records belong to the original session; you own none.                                                                                                                                                                                             |

### Broker envelopes

A validated discriminated union — `message | cancel | subagent_report` — replacing untyped string payload conventions. The broker stamps envelope source from the authenticated connection; receivers never trust payload-claimed identity (a `subagent_report` is accepted only when the stamped source matches an owned child with an open ledger entry; forged ids in payloads are inert). The broker itself is unchanged in scope: session ids and reachability, nothing else. No dispatch envelope exists — a task only ever arrives via handoff bootstrap, so wake is materialization plus ordinary messaging.

### Feature ports (the only live surfaces between features)

```ts
interface MessagingHandle {
  sendMessage(req): Promise<SendResult>; // durable sent record + envelope
  cancelSession(sessionId): Promise<CancelResult>;
  listSessions(): Promise<string[]>;
  waitForSession(sessionId, timeoutMs): Promise<boolean>;
  onIncomingMessage(handler): void;
  onIncomingCancel(handler): void; // typed handlers own durable acceptance before ack
}
```

Handoff accepts injected launch targets (inert data plus a `launch` function whose interface handoff owns); the sub-agents feature returns `{ launchTarget, roster, classify }` for the root to inject into handoff, search, and the board. All ports are constructor parameters created by the root — no registry, no events, no globals.

### Derived states

No stored status field exists. States are recomputed from evidence — active-branch ledger records, child-file records, stamped windows, broker registration — by one classification module shared by board, search, and reconciliation. Reducer precedence per child:

1. window + cancellation → **stopping** (failed kills stay here honestly; never a duplicate spawn while a kill is unverified)
2. window, never yet broker-registered → **starting** (observed 16–20 s registration lag; the grace binds to _first_ registration — later broker loss with a live window is `busy`, tmux is truth)
3. window → **busy** (includes linger-while-observed and follow-up turns)
4. no window, broker-live → **active** (externally resumed; displayed, not managed; live-cancel reaches it; wake never duplicates it)
5. no window + report or closure on the child's active branch → **completed** (wins over a coexisting cancellation — a natural completion racing a cancel is an acceptable terminal state; the cancel converges as a no-op)
6. no window + cancellation → **stopped** (wakeable; a later message supersedes)
7. no window + suspension record → **suspended** (restored automatically at parent resume)
8. no window, obligation open, no explanation → **interrupted** (never auto-restarted; a message restarts it)

An unreadable or mid-write child file classifies as unknown, never completed, and defers to the next trigger.

## Design Decisions

### 1. One advertised entrypoint, wired by a composition root

Pi loads each advertised entrypoint in an isolated jiti module graph (`moduleCache: false`, verified in pi v0.80.6 `core/extensions/loader.ts`), so multi-entrypoint packages cannot share module state — the first implementation's `Symbol.for` process global and event-bus seams were compensations for that self-inflicted isolation. One entrypoint makes plain imports and constructor injection work everywhere; the composition root makes every composition decision at registration time, in code, once. Composite tools (wake-aware send, ownership-aware cancel) live in the sub-agents feature and call down into the messaging handle — the runtime cycle is not managed; it is gone. Costs accepted: features toggle in settings rather than pi's extension list, and one feature's install failure fails the package loudly (installers construct and validate before registering).

### 2. Sub-agents carry a single obligation for life

One task, given at birth via the handoff kickoff; one completion obligation; disposable afterward. Steering and follow-ups are ordinary messages; genuinely new work is a new child. This deletes the run/re-tasking machinery a generalized model needs (run minting, per-run response policy, run-scoped cancellation, dispatch envelopes, kickoff replay protocols) while keeping the affordances that matter: correcting a child mid-flight, and asking a finished child for more detail. `requestResponse` fixed at launch is _correct_ under this model, not a limitation.

### 3. Completion is a report: durable child record, dedicated turn-terminating tool

Only `report_results` means "the task is complete" — interim messages never satisfy the obligation (the observed bug class this kills). The tool's reframe as _report to parent_ also serves follow-ups: every parent-expected answer uses the same durable-record → deliver → terminate-turn → exit mechanics, so the child has one uniform instruction and the parent-unavailable flow needs no special schema. The child file is the mailbox of record; broker delivery is a latency optimization; every recovery path reduces to reading a JSONL whose path is already durable. Parent acceptance implies parent durability: the typed handler appends the receipt before the broker ack, so a child that observes success can exit safely.

### 4. Dormant by default; exit at settle; linger while observed

Kept from the first design 18 — its one unambiguously right call. A pi process holds nothing durable its session file does not, so an idle process buys only wake latency and costs an entire state dimension. Busy means a window exists; dormant means nothing exists. At settle the child checks for attached tmux clients and lingers broker-live until detach (observation is a first-class reason to stay resident; `remain-on-exit` dead panes were rejected because window-exists must mean worker-busy).

### 5. The ledger is authoritative; tmux converges to it; writer-scoped, branch-aware

Also kept: event-time appends (never shutdown snapshots), desired set walked back from the current leaf (rewinds behave correctly for free — reconciliation after `session_tree` may kill or restore workers, deliberately), writer scoping so fork-copied history confers nothing. Manual tmux interference is undefined behavior that self-heals toward the ledger.

### 6. Trigger-only, single-flight reconciliation; no monitor

Triggers: parent `session_start`, `agent_settled` (not `agent_end`, which races queued continuations), `session_tree`, board open/refresh, relation-scoped search, wake-on-send, cancellation, incoming report. Concurrent triggers coalesce onto one in-flight run with a dirty-flag follow-up (two overlapping reconciles both observing "no window" is a guaranteed duplicate-spawn bug). Shape: compute a plan from evidence, then apply bounded actions — recover missed reports/closures (fold by `reportId`), restore suspended workers, converge `stopping`, kill undesired windows, close confirmed ownership. Reconciliation **never initiates work**: no crash restarts, no resends (see 7). Each child file opens at most once per operation; no persistent cache — rereading at the next trigger is acceptable. Staleness between triggers is accepted; with reports arriving as envelopes and closures reconciling lazily, nothing correctness-critical consumes monitor-grade freshness.

### 7. No automatic restart; uniform suspend with records; auto-restore only what was suspended

Restoring a deliberately suspended worker honors recorded intent; restarting a crashed one is a retry loop. Only the former is automatic. Every non-reload shutdown (`quit`/`new`/`resume`/`fork`) appends a suspension record, then kills the per-parent tmux session (SIGHUP cascades gracefully and recursively; verified to allow unbounded cleanup) — the forgotten pane stays structurally impossible. `reload` leaves workers running; post-reload reconciliation adopts them. At parent resume, reconciliation restores suspended workers (bounded: one restore per suspension record) and reports — but never touches — `interrupted` ones. Explicit recovery is a message: wake-on-send is the restart surface for both agent and user. This deletes the ephemeral crash-retry budgets the first design needed. Racy shutdown-gap events are not specially handled; next-start reconciliation is the single eventual-consistency mechanism.

### 8. Forks are disowned loudly, in both planes

Structure already agrees: in the index, a fork is a _sibling_ of the original's children, never their ancestor. Physically copied ledger entries fail writer scoping, and the copied identity record fails the child-side self-check, so a forked parent owns nothing and a forked child exposes no sub-agent behavior. Because the forked _model_ can still see the copied history in context, the fork's first reconciliation appends a one-shot model-visible notice that those sub-agents belong to the original session.

### 9. Cancellation is idempotent convergence, not a tombstone

Durable intent precedes runtime mutation (crash between intent and kill converges at the next reconcile). Completion racing cancellation is acceptable in either order — if a report exists, `completed` wins and the cancel is a no-op; otherwise the child converges to `stopped`, which suppresses restore but never blocks waking (the wake message is the explicit supersession). Failed kills report `stopping` and retry at later reconciliation points; a worker is never reported `stopped` while a process may exist.

### 10. The missing-report policy is bounded by durable markers

A `requestResponse: true` child that settles without reporting gets exactly one reminder, recorded as a durable child-side marker (no re-reminding after restarts). If it settles reportless again, the system appends a closure record (`no_report_after_reminder`) and the child exits; the parent sees `interrupted`-grade detail in the roster. Fire-and-forget children write their closure at first settle — lifecycle completion without model-facing delivery on either side.

### 11. Search is a selector over three evidence planes; branch vantage is a relationship-plane axis

Content (index), presence (runtime), relationship (transcript ledgers) — each optional, composable, resolved by its own authority, intersected by id set. The roster is `relation: "subagents"`, not a pseudo-`kind` that swaps the tool's data source. Branch scoping is not a filter peer of `live:`; it is the vantage from which relationship truth is read (`branch` for ownership and the roster, `tree` for history and forensics), applicable to every current and future relation value and meaningless — thus invalid — without one. Stale index classification can never exclude an owned child, because scope resolution never consults the index.

### 12. Depth limits gate launches, not visibility

`sessions.subagents.maxDepth` (default 2) removes the `subagent` launch value from the tool schema at the configured durable depth. Recursive visibility is never capped — an earlier depth-capped traversal hid still-running descendants.

### 13. Model guidance lives in user instructions, not tool schemas

Tool descriptions state capabilities (launch values, `requestResponse` semantics, wake behavior); recommendations about which model suits which delegated work belong in `AGENTS.md`-class instructions.

## Edge Cases & Failure Modes

- **Send races child exit at settle:** wake-on-send retries; window-present-but-unregistered gets a bounded wait, then one verified kill-and-respawn; readiness never arriving leaves a visible `starting` row for the next reconcile, never a silent abandon.
- **Cancel races natural completion:** both orders acceptable; report evidence wins; the cancel converges as a no-op (Design Decision 9).
- **Failed tmux kill:** `stopping`, retried later; never a duplicate spawn while a kill is unverified.
- **Child crashes between report record and delivery:** the record is durable; parent reconciliation recovers it (`provenance: recovered`); live receipt plus recovery fold by `reportId`.
- **Parent closed when child reports:** delivery fails, child exits; the durable report waits; parent resume reconciles, appends the receipt, and shows the one-line reminder.
- **Crash between parent receipt and broker ack:** child retries or exits; duplicate receipts fold by `reportId`.
- **Manual `tmux kill-window` / killed per-parent session:** busy workers classify `interrupted` (no auto-restart; visible, wakeable); dormant workers unaffected; missing tmux session = empty window set.
- **Rewind above a launch:** desired set shrinks; the window is killed silently; rewinding back restores per suspension/desired rules. Cancellation rewound above revives desired-open state.
- **Fork:** zero owned workers (writer scoping + identity self-check), sibling in the index, one-shot disowned notice; the original's workers suspend at its shutdown and restore when _it_ resumes.
- **External resume of a dormant child:** broker-live without a window → `active`; parent messages route to it; wake never spawns a duplicate; live-cancel reaches it.
- **Extension reload mid-fanout:** workers keep running; post-reload reconciliation adopts from ledgers, windows, and child files.
- **Broker registration lag (observed 16–20 s):** `starting` grace bound to first registration; tmux-busy counts as live immediately.
- **Unreadable/mid-write child file:** unknown, never completed; defer to next trigger.
- **Stale async after replacement/reload:** no feature retains a raw `ExtensionContext`; session-scoped state (id + epoch) is swapped at `session_start`/`session_shutdown`, and every async continuation re-checks the epoch immediately before side effects.
- **Quoting:** persisted resume commands, window titles, and cwds are safely quoted once, at write time; window names never carry identity (the stamped option does).

## Alternatives

### Generalized run model (repeatable tasking per child)

- **Status:** Rejected
- **Decision:** Sub-agents are single-obligation and disposable; the run machinery (minting rules, per-run response policy, dispatch envelopes, run-scoped cancellation, kickoff replay) solves re-tasking, which is a non-goal.
- **Discussion:** The architecture review's strongest draft was built on runs. It was internally sound but generalized past the product: the affordances users actually need (steering, follow-ups, restart-to-continue) all fit inside one obligation. The report model retains the delivery guarantees runs provided.

### Multiple advertised entrypoints with event-bus seams (first design 18, as implemented)

- **Status:** Rejected
- **Decision:** The resolver/cancel-provider seams were runtime cycles behind an emitter, with early-listener and unready-service failure modes; the `active.ts` process global existed only because module graphs are isolated. The composition root deletes the seams, the global, and the discovery problem.

### Background monitor (1 s tmux poll)

- **Status:** Rejected
- **Decision:** Trigger-only reconciliation. Nothing correctness-critical consumes poll-grade freshness once reports are envelopes and closures reconcile lazily; the monitor kept warm a cache that no longer exists.

### Ordinary-message replies for follow-ups

- **Status:** Rejected
- **Decision:** Every parent-expected answer goes through `report_results`. Ordinary replies lack a recovery marker (sent records append only on successful delivery — precisely the failing case), a turn-termination signal, and a uniform child instruction.

### Dedicated roster tool / `kind: "my-subagents"` enum value

- **Status:** Rejected
- **Decision:** The roster is `relation: "subagents"` in the three-plane selector. A dedicated tool duplicated a selector surface (tool bloat); the pseudo-kind swapped the tool's data source behind an enum value and made half the other filters meaningless. The `relation`/`relationScope` axes give the same preset with honest semantics — and legitimize `live:` retroactively.
- **Discussion:** An orthogonal `owner: "mine"` filter was also rejected: `kind: user` + `owner: mine` is an expressible contradiction, the exact invalid-combination disease enums were chosen to avoid.

### Automatic crash restart with retry budgets

- **Status:** Rejected
- **Decision:** No automatic restart; `interrupted` is visible and a message restarts. Budgets required ephemeral cross-trigger bookkeeping and still risked loops; if interruption proves to be a regular problem, a bounded budget can return later without any record-schema change.

### Resident idle processes · registry files · broker materialization/presence · startup auto-sweep · `remain-on-exit` panes · separate `/subagent` command

- **Status:** Rejected (carried forward from the first design 18, whose reasoning stands)
- **Decision:** Dormancy over residency; stamped window options over registries; the broker stays id-only and dumb (materialization is ledger-domain, presence flags are scope creep); adoption-plus-self-termination over sweeps that cannot distinguish orphans from the crash-to-resume gap; windows close with their process; one `/handoff` entry point.

## Implementation Plan

Every phase is independently shippable: `npm run check` green, no half-finished concept exposed, inert-but-unused code acceptable. Phases assume the post-cleanup baseline (`845739b`: designs 15/16/17 implemented; the first 18's implementation discarded). Design 16's surfaces — child-file bootstrap persistence, kickoff entries, launch receipts, the canonical resume-command builder — are consumed as-is, not rebuilt.

- [x] Phase 1: Composition root
  - Goal: One advertised entrypoint wiring all existing features with behavior identical to today; `active.ts` deleted.
  - Files: new `extensions/pi-sessions.ts`; `package.json` (`pi.extensions`); each `extensions/session-*.ts` entrypoint becomes an `install*` function in its feature directory; `extensions/shared/settings.ts` (`sessions.features` toggles); delete `extensions/shared/session-broker/active.ts`; search's live-filter path takes the messaging handle as a parameter.
  - Work: Root constructs settings → index → messaging → handoff/search/ask/auto-title/hooks in order; single `session_start`/`session_shutdown` subscription driving feature hooks deterministically (broker registration outcome first); disabled features are explicit `undefined` wiring with loud notices; epoch-guarded session state object owned by the root.
  - Validation: Full test suite passes with entrypoints converted; smoke: search `live:` works via injected handle; disabling `features.messaging` degrades search's live filter with the existing notice; broker duplicate-registration still rejects loudly.

- [x] Phase 2: Typed envelopes and the messaging handle
  - Goal: Broker traffic is a validated `message | cancel` union; `session_cancel` ships for broker-live targets; the `MessagingHandle` port exists.
  - Files: `extensions/shared/session-broker/protocol.ts`, `client.ts`; `extensions/session-messaging/pi/` (service, tools, incoming runtime); tests.
  - Work: Envelope union with TypeBox validation and broker-stamped source; named incoming handlers with durable-before-ack ownership per kind; `cancelSession` → target runtime `ctx.abort()`; plain `session_cancel` tool (live targets; dead targets error); `waitForSession`.
  - Validation: Envelope round-trip and forged-source tests; smoke: cancel a live session's turn from another session.

- [x] Phase 3: Tmux substrate and visible tmux splits
  - Goal: Tmux helpers exist; direction launches split tmux when `$TMUX` is set. No sub-agent exposure yet.
  - Files: new `extensions/shared/tmux.ts`; `extensions/session-handoff/launch/tmux.ts`; launch resolution; tests.
  - Work: Detection (`$TMUX` before `TERM_PROGRAM`); per-parent session naming; idempotent create/list/verified-kill helpers; `@pi_session_id` stamping and `list-windows -F` queries; direction backend via `split-window`.
  - Validation: Faked-exec unit tests; scripted probe against real tmux (stamping, SIGHUP delivery, session-dies-with-last-window); smoke: `/handoff --right` inside tmux.

- [ ] Phase 4: Sub-agent launch and the happy path
  - Goal: `launch: "subagent"` end to end: spawn detached, kickoff, `report_results`, receipt, exit.
  - Files: new `extensions/subagents/` feature (identity, ledger, report tool, child lifecycle, launch target); handoff schema gating (tmux present, depth < maxDepth, registered at `session_start`); root wiring; tests.
  - Work: Identity record prewritten; `subagent_launched` ledger entry; `subagent_report` durable-before-delivery; `subagent_report` envelope kind with parent receipt durable-before-ack; turn termination; exit at settle; linger while a tmux client is attached; `requestResponse` default true for this launch value; launch-failure output names the surviving prepared session.
  - Validation: Ledger/identity tests including fork self-check failure; smoke: delegate, watch the window, receive the report, `tmux ls` empty afterward.

- [ ] Phase 5: Wake-on-send and follow-ups
  - Goal: Messaging a dormant owned child materializes it and delivers; follow-up answers arrive as reports.
  - Files: composite `session_send_message` in `extensions/subagents/`; root registration choice; tests.
  - Work: Routing (live → send; owned dormant → respawn, bounded broker wait, verified kill-and-respawn once, send; dead unknown → error); wake supersedes cancellation; steering vs follow-up needs no transport distinction; report tool serves follow-up answers identically.
  - Validation: Race tests (window-present-unregistered, stale-window kill failure); smoke: complete a child, send a follow-up, receive a second report.

- [ ] Phase 6: Reconciliation, shutdown, and recovery
  - Goal: Trigger-only single-flight reconcile converging tmux to the ledger; suspend/restore; missed-report recovery; fork notice; missing-report policy.
  - Files: `extensions/subagents/reconcile.ts`, classification module, shutdown hooks, child-side closure/reminder records; tests.
  - Work: Plan-then-apply with the eight-state reducer; triggers wired (`session_start`, `agent_settled`, `session_tree`, cancellation, wake, incoming report); single-flight with dirty flag; suspension records + tmux-session kill on non-reload shutdown; reload adoption; auto-restore suspended, never interrupted; recovered receipts (`provenance: recovered`, fold by `reportId`) with the one-line reminder; fork disowned notice; reminder-then-closure policy; ownership-closed entries.
  - Validation: A test per reducer row and per reconcile action with fixture files; rewind/fork fixtures; smoke: quit mid-fanout → resume → suspended workers restore, interrupted ones do not; kill a window manually → `interrupted`, message restarts it.

- [ ] Phase 7: Composite `session_cancel`
  - Goal: Ownership-resolved cancellation with honest convergence.
  - Files: `extensions/subagents/cancel.ts`; root registration choice; tests.
  - Work: Owned → durable intent, live-cancel envelope, verified kill, reconcile (unverified → `stopping`); otherwise Phase 2 behavior.
  - Validation: Intent-before-kill and failed-kill tests; smoke: cancel busy worker → `stopped`, wake revives it; completion-races-cancel test.

- [ ] Phase 8: Three-plane search
  - Goal: `relation`/`relationScope`/`kind` land; the roster is a search preset.
  - Files: `extensions/session-search/` (schema, scope resolution, annotations); `extensions/shared/session-index/` (`SessionOrigin` + schema version bump); roster/classify consumed via root injection; tests.
  - Work: Scope-resolver mechanism generalizing `includeSessionIds`; transcript ledger walk (branch and tree vantages, writer-scoped, recursive with depth); state/`onActiveBranch` annotations and scope totals; `origin: subagent` extraction; relation reads trigger reconcile; managed-live semantics for `live:` under a relation scope.
  - Validation: Branch/tree vantage fixtures (abandoned-branch child excluded from branch, present in tree); stale-index-never-excludes-owned test; filtered-empty scope totals; full reindex.

- [ ] Phase 9: Handoff board
  - Goal: Bare `/handoff` opens Subagents | History matching the preserved mockups.
  - Files: board module in `extensions/session-handoff/`; command routing; tests.
  - Work: Tabs, quiet grid (display-width aware), Details pane, state-gated actions (stop with confirm, copy-observe on busy, copy-resume only where safe); History normalizes design 16's launch receipts through their existing shared view model, across all branches, newest first, copying via `copyToClipboard()`; `--subagent` flag; non-TUI notice.
  - Validation: Component tests; terminal-control iteration against `docs/designs/18-tmux-subagents/` captures as the acceptance target.

- [ ] Phase 10: Documentation and end-to-end evidence
  - Goal: Docs match shipped behavior; the whole system demonstrated.
  - Files: `README.md`, `CHANGELOG.md`, `CONTEXT.md` (vocabulary from Exposed Shape), `DEV.md` project structure, this doc's checkboxes; delete `18-tmux-subagents.md` and drop this file's `-2` suffix.
  - Work: update-docs pass; scripted end-to-end: fan out two sub-agents, steer one, observe via attach, quit mid-work, resume, watch suspended restore + report recovery + reminder, follow-up on a completed child, cancel the other, verify the board reflects every state.
  - Validation: Full `npm run check`; the scripted scenario passes.
