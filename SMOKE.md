# pi-sessions smoke test

This is the end-to-end manual recipe for verifying reindex, search, live discovery, ask, and hook-maintained freshness.

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

## 4. Verify live session discovery

Open two Pi sessions with `pi-sessions` loaded. In one session, prompt Pi to call:

```text
Use session_search with live true and limit 5. Return session ids, titles, cwd, and relation only.
```

Expected:

- the other live session is returned if it is present in the session index
- the current session is returned with `relation: "self"`
- results use index metadata, not broker registration metadata

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
