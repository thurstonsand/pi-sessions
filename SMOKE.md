# pi-sessions smoke test

This is the end-to-end manual recipe for verifying reindex, search, live discovery, ask, hook-maintained freshness, and the subagent lifecycle.

## 1. Load the package

```bash
pi -e ~/Develop/pi-sessions
```

## 2. Run a full reindex

Inside Pi:

```text
/session-index
```

Then:

- press `r`
- confirm the rebuild

Expected:

- the rebuild finishes successfully
- the index exists at `~/.pi/agent/pi-sessions/index.sqlite`
- `/session-index` shows a schema version, session count, and last full reindex time

## 3. Verify text search

Prompt Pi to call the tool:

```text
Use session_search with query "session_query OR \"session search\"" and limit 3.
```

Expected:

- ranked session rows are returned
- evidence includes snippets from indexed session text
- snippet markers are rendered for matched terms

## 4. Verify reachable session discovery

Open two Pi sessions with `pi-sessions` loaded. In one session, prompt Pi to call:

```text
Use session_reachable. Return session ids, titles, cwd, state, and relation only.
```

Expected:

- the other live session is returned
- the current session is absent
- titles and cwd come from the session index; a live session missing from the index is still returned as a bare id

With a subagent running, ask for `scope: "branch"` and expect the worker rows with `state`, `depth`, and goal.

## 5. Verify follow-up analysis

Take one returned session id and ask:

```text
Use session_ask with session "<session-uuid>" and answer what decisions were made.
```

Expected:

- answer is grounded in the chosen session
- answer comes from the full rendered session tree, not a guessed summary

## 6. Verify hook-maintained freshness

Use a fresh disposable working directory.

Create a temp repo-ish directory:

```bash
SMOKE_DIR=$(mktemp -d /tmp/pi-sessions-smoke.XXXXXX)
mkdir -p "$SMOKE_DIR/.git" "$SMOKE_DIR/smoke"
printf 'ORIGINAL_TOKEN\n' > "$SMOKE_DIR/smoke/source.txt"
cd "$SMOKE_DIR"
```

Launch Pi in that directory with `pi-sessions` loaded:

```bash
pi -e ~/Develop/pi-sessions
```

In the new Pi session, ask it to:

- read `smoke/source.txt`
- edit `smoke/source.txt`
- write `smoke/generated.txt`

Example prompt:

```text
Read smoke/source.txt, replace ORIGINAL_TOKEN with UPDATED_TOKEN_PHASE3, and write smoke/generated.txt containing HOOK_PHASE3_WRITE_TOKEN.
```

Expected:

- the files are changed on disk
- **without rerunning `/session-index`**, a new Pi invocation can find the fresh session immediately

Verification prompt:

```bash
cd "$SMOKE_DIR"
pi -e ~/Develop/pi-sessions -p "Use session_search with repo \"$SMOKE_DIR\" and files.changed [\"smoke/generated.txt\"]. Return the session id and file_touch evidence only."
```

Expected:

- the just-created session is returned
- file-touch evidence includes `smoke/generated.txt` with `op: changed`

## 7. Verify compaction hook

In the same live session, trigger compaction:

```text
/compact
```

Expected:

- compaction succeeds
- the session remains searchable
- compaction summary text is indexed on the next hook flush

## 8. Verify tree-navigation hook

In the same live session, navigate with:

```text
/tree
```

Select a prior point and choose summarization.

Expected:

- a branch summary entry is created
- branch summary text becomes searchable after the hook flush

## 9. Recovery test

If hooks were disabled or the DB was removed/corrupted:

- reopen Pi
- run `/session-index`
- press `r`
- confirm rebuild

Expected:

- historical sessions are restored to the sidecar index
- search works again without query-time repair behavior

## 10. Verify auto-titling

In a fresh unnamed session:

- send a substantive first prompt
- confirm a descriptive session title appears after the turn finishes
- continue until the refresh threshold is crossed and confirm the title only changes when it meaningfully improves
- run `/name Manual Smoke Title` and confirm future automatic retitles stop
- run `/title this` and confirm the session gets a fresh generated title again

## 11. Verify the subagent lifecycle

Subagents require the `messaging` and `handoff` features and a working `tmux` binary. Launch Pi from inside a tmux session so the `subagent` launch value is available and observation stays local:

```bash
tmux new -s smoke-parent
pi -e ~/Develop/pi-sessions
```

### Fan out two subagents

Ask the parent to delegate two independent background tasks, for example:

```text
Delegate two subagents: one to summarize README.md, and one to summarize CHANGELOG.md. Ask both to report back when done.
```

Expected:

- two `session_handoff` calls with `launch: "subagent"`
- both launches succeed on the first attempt; neither fails with `duplicate session: pi-<parent-id-prefix>`
- `tmux ls` shows a detached `pi-<parent-id-prefix>` session with one window per worker
- `/handoff` opens the **Handoffs** board with both workers on the **Subagents** tab, showing `starting` then `busy`

### Steer one worker

While a worker is still `busy`, have the parent send it a steering message:

```text
Send a message to the README subagent telling it to keep the summary under three sentences.
```

Expected:

- the message reaches the running worker's current turn; no new obligation is created
- the worker's eventual report reflects the steer

### Observe via attach

From the board, copy the observe command on a `busy` row (or run it directly):

```bash
tmux switch-client -t pi-<parent-id-prefix>   # inside tmux
tmux attach -t pi-<parent-id-prefix>          # outside tmux
```

Expected:

- the worker's live pane is visible; detaching returns you to the parent and the worker lingers only while a client is attached

### Receive reports

Let both workers finish.

Expected:

- each worker calls `submit_task_report`, the parent shows a `Report from subagent “<title>”` message with the summary, and its window disappears
- once both windows are gone, `tmux ls` no longer lists the `pi-<parent-id-prefix>` session
- the board shows both workers as `completed`

### Quit mid-work, then resume

Start a third, slower subagent, and quit the parent while it is still `busy`:

```text
Delegate a subagent to write a detailed audit of the extensions/ directory and report back.
```

Then `/quit` the parent.

Expected on quit:

- a suspension record is written and the `pi-<parent-id-prefix>` tmux session is killed (no orphaned panes: `tmux ls` no longer lists it)

Resume the parent with its resume command. Expected:

- the suspended worker restores in a fresh window (auto-restore of suspended, not interrupted)
- if a worker finished while the parent was closed, its report is recovered and injected with `provenance: recovered`
- a `requestResponse` worker that settled without reporting produces exactly one reminder, then a closure record if it settles reportless again; the board surfaces it as `interrupted`-grade detail

### Follow-up on a completed worker

Ask the parent to follow up with one of the `completed` workers:

```text
Ask the README subagent to also list the top-level headings it saw.
```

Expected:

- the dormant worker wakes (a new window appears), answers with a second report, and exits again; completion never regresses

### Cancel a worker, then revive it

Start another worker, then cancel it while `busy`:

```text
Cancel the audit subagent.
```

Expected:

- a cancellation record is written before any kill; the worker converges to `stopped` (or `stopping` if a kill needs a retry)
- sending it a message afterward supersedes the cancellation and restarts it

### Verify the board reflects every state

Run `/handoff` and confirm the **Subagents** tab shows the right derived state for each worker across the run: `busy`, `completed`, `interrupted`, and `stopped`, with the stop / copy-observe / copy-resume actions gated by state. Confirm the **User sessions** tab lists any directional or deferred handoffs made during the run.
