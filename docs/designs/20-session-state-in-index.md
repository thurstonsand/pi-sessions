# Session state in the index

## Status

Draft

## Decision Summary

Promote the SQLite session index from a search cache to the read model for observing other sessions: durable session state — starting, subagent lineage, ledger lifecycle, closure, reports-exist — is mirrored into the index at the moment its transcript entry is written, and observation surfaces query SQL instead of opening transcripts. Transcripts remain the sole source of truth and the index remains fully rebuildable from them; runtime evidence (tmux windows, broker presence) is never stored and overlays at query time. The key tradeoff: writers take on a small synchronous index write per state event so that every reader drops file parsing entirely.

## Problem Statement / Background

The handoff startup work added a `starting` state to three observation surfaces: the receiver-side message reject, subagent classification, and `session_search`/`session_ask`. A live smoke test confirmed the reject works end-to-end but exposed a structural gap in the query surfaces:

- `session_search relationScope: tree` returned `scope: { matched: 0, total: 4 }`. The roster knew about all four subagents in the tree, but every one was discarded because `session_search` only returns rows that exist in the index, and freshly-launched subagent children were not indexed.
- `session_ask` on a deferred (created-but-unlaunched) child failed at target resolution with "No indexed session found," never reaching the starting short-circuit.

Investigation reframed the root cause. The child session file is flushed to disk at handoff creation, before launch (`prepareHandoffLaunch` writes header, title, and bootstrap so `pi --session-id` can find it). The starting window is not a no-file window — it is a no-index-row window. The index row is born too late, because only a session's own hooks write its row, and a starting session has no running process.

The gap generalizes. Every observation surface today recovers state by opening transcripts at call time: subagent reconciliation opens each child transcript for `getChildSubagentLifecycle` / `isSessionStarting`, the roster re-derives lineage by traversing parent ledgers and opening descendants, `session_search live: true` opens every live transcript to find `starting`, and the handoff board reads each non-subagent child to compute `hasStarted`. The index — already the fast store these surfaces query for everything else — carries none of this state, so observation is either scattered file parsing or simply blind.

This design supersedes the earlier deferred draft of itself, which proposed caching state but left the write triggers, truth regimes, and schema unresolved.

## Goals

- Make durable session state — starting, subagent lineage and lifecycle, closure, report existence — queryable from the index without opening transcripts at call time.
- Give a starting or just-launched session an index row during its starting window, so `session_search` and `session_ask` can observe it.
- Keep the index a rebuildable projection: a from-scratch reindex reproduces all durable state from transcripts alone, with no side-channel inputs.
- Establish which reads belong to the index and which belong to a session's own memory, as a documented principle.

## Non-Goals

- Making the index a source of truth for anything. Transcripts remain authoritative; the index only lags them, never leads.
- Storing runtime evidence. Broker presence, tmux window existence, and registration are live-only facts, not reconstructable from transcripts, and stay query-time.
- Converting the reconciler. As the converger it must read durable truth and recover report payloads, which live only in transcripts.
- Converting the messaging receiver-side reject. It reads the session's own in-memory branch — self-knowledge, not observation (see Decision 1).
- Backwards compatibility for existing index files. The schema version bumps; the index rebuilds once.

## Exposed Shape

### Schema

New columns on `sessions`, written by the child's own sync and at birth:

```sql
is_starting INTEGER NOT NULL DEFAULT 0     -- unconsumed handoff bootstrap on the active branch
closed_at TEXT                             -- from the subagent closure entry
report_count INTEGER NOT NULL DEFAULT 0    -- reports filed by this session as a subagent
subagent_owner_session_id TEXT             -- from the bootstrap's subagent identity block
subagent_depth INTEGER
```

New table, owned wholesale by each owner's branch recompute:

```sql
CREATE TABLE session_subagent_ledger (
  owner_session_id TEXT NOT NULL,
  child_session_id TEXT NOT NULL,
  title TEXT NOT NULL,
  goal TEXT NOT NULL,
  model TEXT,
  cwd TEXT NOT NULL,
  resume_command TEXT NOT NULL,
  launched_at TEXT NOT NULL,
  depth INTEGER NOT NULL,
  cancelled INTEGER NOT NULL DEFAULT 0,
  suspended INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (owner_session_id, child_session_id)
);
```

A reader derives the durable half of `SubagentState` with one join; runtime evidence (tmux, broker) overlays at query time to distinguish `busy`/`active`/`interrupted`.

### Write points

Every durable state event mirrors into the index in the same code path that appends the transcript entry:

| Event                                   | Writer                                  | Index write                                                           |
| --------------------------------------- | --------------------------------------- | --------------------------------------------------------------------- |
| Handoff prepared                        | parent process (`prepareHandoffLaunch`) | child's birth row: `is_starting = 1`, identity, goal, title           |
| Subagent launched                       | owner process                           | ledger row insert                                                     |
| Cancelled / suspended / report-received | owner process                           | ledger row update                                                     |
| Kickoff consumed, closure, report filed | child's own hooks (tail sync)           | child columns                                                         |
| Rewind / fork / compact                 | owner's tree hooks                      | wholesale recompute of the owner's ledger rows from the active branch |

The transcript append always succeeds independently; a failed index write is a lag, healed by later syncs or a reindex, never a failed operation.

### Read surfaces

Converted to SQL in this round:

- `session_ask` target resolution and the starting short-circuit
- `session_search live: true` starting annotations
- `session_search relationScope` / roster observation: recursive SQL walk over `session_subagent_ledger`
- handoff board `hasStarted` for non-subagent handoff children

Deliberately not converted: the reconciler (converger; needs report payloads) and the messaging receiver-side reject (self-read of the session's own in-memory branch).

## Design Decisions

### 1. The index is the read model for observing other sessions

A session reads its own state from its own `SessionManager` — it is the writer of that truth, and the in-memory read is fresher than any cache. The index exists for observation: reading the state of sessions you do not own. This boundary is why the messaging reject stays on `ctx.sessionManager.getBranch()` while every cross-session surface converts to SQL. The rule is documented in `CONTEXT.md` so future surfaces land on the right side without relitigating.

### 2. Durable state only; runtime evidence overlays at query time

`classifySubagent` needs tmux window existence, broker liveness, and registration — none derivable from a transcript. Storing them would create a second, volatile truth regime inside a rebuildable cache, with a staleness contract to match. Instead the index stores only transcript-derivable facts, and readers overlay runtime evidence with the same cheap process calls they make today (one broker `listSessions`, one tmux window listing per owner). A from-scratch reindex is lossless by construction.

### 3. Index-at-birth

`prepareHandoffLaunch` writes the child's index row immediately after flushing the prepared session file, using the same `syncSessionFile` machinery the hooks already use for foreign files. This closes the starting-window visibility gap for both subagent and deferred/directional handoffs: the row exists before any process runs, so `session_search` can list it and `session_ask` resolves it and reaches the starting short-circuit.

### 4. Two write regimes, split by truth structure

Child-side facts (starting flag, closure, reports, subagent identity) are append-only within the child's transcript and safe for tail sync: extraction learns the relevant custom entry types and updates the columns incrementally. Parent-ledger facts (launched, cancelled, suspended) are branch-scoped — a rewind changes the desired set — and tail scans read appended lines in raw file order, branch-blind. Ledger rows are therefore only ever written by recomputing from the active branch (`getBranch()`), wholesale-replacing the owner's rows. When a tail scan encounters a ledger-relevant custom type, it does not interpret the entry; it triggers the branch recompute.

### 5. Event-time mirroring, no dedicated healing

Writers update the index in the same code path as the transcript append, so the SQL walk is fresh to within milliseconds and the roster needs no hybrid transcript fallback. Crash windows — writer dies between append and mirror — are recovered by machinery that must exist anyway: the from-scratch reindex derives everything from transcripts, full sync is that same derivation applied to one session, and tail sync's recompute trigger (Decision 4) picks up ledger entries the mirror missed. No dedicated healing subsystem is built; the failure is rare, benign, and cheap to recover with a reindex.

### 6. Extraction reads the bootstrap-pending entry

At prepare time the child transcript carries only the bootstrap-pending entry — no kickoff metadata, and the parent's launched-ledger entry does not exist yet. Current extraction only recognizes `HANDOFF_METADATA_CUSTOM_TYPE`, so a child indexed at birth would classify as `unknown_child`. This is a latent bug today (children are never indexed before they run) that index-at-birth makes real. Extraction learns to read the bootstrap entry's goal, title, launch kind, and subagent identity, which also keeps a from-scratch reindex correct for sessions that never launched.

This decision became mandatory, not merely correct, once the startup-window bugfix moved subagent identity out of the durable handoff metadata entirely: the bootstrap is now the only place a transcript records who a subagent is. Extraction should reuse `findCurrentHandoffBootstrap` from `session-handoff/metadata.ts`, which already folds the pending/kicked-off/stale lifecycle.

### 7. Break the schema, rebuild the index

The schema version bumps and existing indexes rebuild once. No migration shims, no dual-read paths, no self-healing for pre-upgrade rows: a roster entry with no index row is silently dropped, same as today, because reindexing is cheap and one-time.

## Edge Cases & Failure Modes

- **Writer crashes between transcript append and index mirror:** index lags until that owner's next sync (tail-triggered recompute or full sync) or a manual reindex. Readers see slightly stale state, never invented state.
- **Index unavailable during a mirror write:** the transcript append must already be durable; the mirror failure is swallowed as lag, not surfaced as an operation failure.
- **Rewind past a cancellation:** the tree hook forces the owner's branch recompute; the ledger row's `cancelled` flag reverts because the active branch no longer contains the entry. Tail scans never write ledger facts, so raw-file order cannot resurrect abandoned-branch state.
- **`session_ask` starting short-circuit races kickoff consumption:** the child consumed its kickoff moments ago but its index row still says starting; ask returns a benign retry message once. The child's own session-start sync flips the flag in the same breath as consumption.
- **Deferred child never launched:** birth row persists with `is_starting = 1`; searchable and askable indefinitely, which is the desired observation.
- **Child transcript unreadable:** roster classification reports `unknown`, as today; the ledger row still surfaces the launch metadata.

## Alternatives

### Keep reading transcripts and rosters at query time (status quo)

- **Status:** Rejected
- **Decision:** Does not solve visibility for unindexed sessions, and pays repeated transcript-open cost on every observation. The smoke test showed the visibility gap is real, not just a performance concern.
- **Discussion:** The interim stopgap (`SESSION_STARTING_MESSAGE` telling senders to wait for the session to appear in search) made the behavior predictable but left starting sessions invisible.

### Store the full `SubagentState` including runtime evidence (durable + volatile columns)

- **Status:** Rejected
- **Decision:** Volatile columns create two truth regimes in one table, need a refreshed-at staleness contract, and cannot survive a from-scratch reindex. A single broker call and tmux listing at query time already recover the same facts, fresher.
- **Discussion:** If broker presence ever needs cross-machine reach, revisit as an explicitly volatile companion table — never as reindexable columns.

### Hybrid roster traversal (SQL discovery, transcript reads for direct children)

- **Status:** Rejected
- **Decision:** The hybrid compensated for a freshness weakness the design eliminated. With event-time mirroring, the pure SQL walk is as fresh as the transcripts to within a mirror write.

### Convert the messaging receiver-side reject to an index read

- **Status:** Rejected
- **Decision:** The reject reads the session's own in-memory branch — zero cost, always true. Converting it would replace a read of the truth with a stale cache read of the same fact and add an index dependency to the one path that never had one. Decision 1 makes this a boundary, not an inconsistency.

## Implementation Plan

Implementation proceeds in an isolated worktree (`wt` skill) until tested end-to-end.

- [ ] Phase 1: Schema and rebuildable extraction
  - Goal: The index can derive all durable state from transcripts alone; a from-scratch reindex populates the new columns and ledger table correctly.
  - Files: `extensions/shared/session-index/schema.ts`, `extensions/shared/session-index/common.ts` (version bump), `extensions/shared/session-index/store.ts`, `extensions/session-search/extract.ts`, `extensions/session-search/reindex.ts`, tests.
  - Work: Add the `sessions` columns and `session_subagent_ledger` table; teach extraction the bootstrap-pending entry via `findCurrentHandoffBootstrap` (goal, title, launch kind, subagent identity — the bootstrap is the sole durable carrier of subagent identity) and the child-side custom types (kickoff consumption, closure, reports); add ledger derivation from an owner's active branch; wire both into full sync and reindex.
  - Validation: `npm run check`; unit tests covering bootstrap-only transcripts, rewound owners (cancellation on abandoned branch absent from ledger rows), and a full reindex of real local sessions producing expected rows.

- [ ] Phase 2: Index-at-birth and tail-sync state tracking
  - Goal: A prepared child has an index row before launch; running sessions keep their own state columns current incrementally.
  - Files: `extensions/session-handoff/spawn.ts` (or its caller in `tool.ts`), `extensions/session-search/hooks.ts`, tests.
  - Work: Call the index sync on the child file at prepare time; extend tail scan to update child columns from appended entries and to trigger the owner branch recompute when ledger-relevant custom types appear in the tail.
  - Validation: Unit tests for tail transitions (`is_starting` 1→0 on kickoff, report count increments, tail-triggered recompute); smoke test — create a deferred handoff and observe its row with `is_starting = 1` before any process runs.

- [ ] Phase 3: Event-time mirroring by owners
  - Goal: Ledger mutations reach the index in the same code path as their transcript appends; branch-changing hooks force recompute.
  - Files: `extensions/subagents/install.ts` (launch path), `extensions/subagents/cancel.ts`, `extensions/subagents/reconcile.ts` (append sites), `extensions/session-hooks/install.ts` / `extensions/session-search/hooks.ts` (tree/fork/compact triggers), tests.
  - Work: Mirror launch/cancel/suspend/report-received appends into ledger rows; ensure mirror failures never fail the transcript write; force owner ledger recompute on `session_tree`, fork, and compact.
  - Validation: Unit tests per event; smoke test — launch a subagent, query the ledger table mid-turn (before `turn_end`) and see the row.

- [ ] Phase 4: Convert the readers
  - Goal: Observation surfaces stop opening transcripts.
  - Files: `extensions/session-ask/install.ts`, `extensions/session-search/install.ts`, `extensions/subagents/roster.ts`, `extensions/session-handoff/board.ts` / `board-view-model.ts`, tests.
  - Work: `session_ask` starting short-circuit reads `is_starting`; `session_search live: true` annotations read the column instead of opening live transcripts; roster observation becomes a recursive SQL walk over `session_subagent_ledger` joined to `sessions`, with runtime evidence (tmux, broker) overlaid at query time — the reconciler still converges but no longer feeds observation reads; board `hasStarted` reads the index.
  - Validation: `npm run check`; re-run the original smoke test — `session_search relationScope: tree` surfaces all subagents with states, `session_ask` on a deferred child returns the starting answer.

- [ ] Phase 5: Documentation and closure
  - Goal: Docs match the new read model.
  - Files: `CONTEXT.md`, `DEV.md` (gotchas if any emerged), `README`/feature docs as applicable.
  - Work: Verify the read-model and ownership-rule entries in `CONTEXT.md`; update the session-index description ("read-layer cache" → read model with mirroring); note the one-time reindex in release notes.
  - Validation: `update-docs` skill pass; final end-to-end smoke test across two live sessions.
