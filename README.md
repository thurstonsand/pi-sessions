# pi-sessions

Pi package for historical session discovery, follow-up questioning, deliberate session handoff, and hook-maintained indexing.

## What it provides

- `session_search` — find relevant prior sessions by text, repo, cwd, time range, and touched files
- `session_ask` — ask questions about one chosen session by reading the **entire session tree**
- `/handoff <goal>` — generate a structured handoff draft, review it, and start a fresh child session
- `/session-index` — small control panel for index status and explicit full reindex
- `/retitle` — regenerate the current session title on demand
- automatic session titling — generates and refreshes titles every N turns using a lightweight LLM call
- hook-driven freshness for future sessions after the first full reindex

## Current model

`pi-sessions` uses a local SQLite sidecar index at:

```text
~/.pi/agent/pi-sessions/index.sqlite
```

You can override the index directory via Pi settings:

```json
{
  "sessions": {
    "index": {
      "dir": "~/.pi/agent/pi-sessions"
    }
  }
}
```

The package has two modes of keeping that index current:

1. **Full reindex**
   - bootstrap for all existing sessions
   - recovery path if indexing was interrupted or hooks were disabled
2. **Hooks**
   - keeps future sessions current without doing indexing work on the search path

Search itself only opens the DB, runs the query, and returns ranked session rows.

## Install / load

### Local package

Run Pi with the package path:

```bash
pi -e ~/Develop/pi-sessions
```

Or add the package to your Pi package list once you decide where it should live permanently.

## First-time onboarding

On a fresh install, run a full reindex once.

1. Start Pi with `pi-sessions` loaded
2. Open:

```text
/session-index
```

1. Press `r`
2. Confirm the rebuild

That rebuilds the index from all sessions returned by `SessionManager.listAll()`.

## `/handoff`

Behavior:

- run `/handoff <goal>` from an active session
- the extension serializes the current conversation branch and asks the active model to call an internal `create_handoff_context` extraction tool
- the final first message for the new session is assembled in code, not free-written by the model
- a review overlay appears before switching sessions
- if you do nothing, the draft auto-starts after 8 seconds
- `Enter` — start the new session immediately
- `Esc` — cancel
- `e` — open the built-in editor for full prompt editing
- `j` / `k` — scroll the draft preview and pause auto-start

The new session is created through `ctx.newSession({ parentSession })`, so the child session keeps native Pi parent linkage.

### Handoff autocomplete

Behavior:

- type `@session` in the editor to browse prior sessions
- the default view pins lineage-linked sessions first, then shows recent sessions from the current repo or current cwd
- `Alt+A` widens the list to all indexed sessions while still pinning lineage-linked sessions at the top
- the list is scrollable rather than capped to a tiny fixed slice
- selecting a suggestion inserts `@session:<session-id>`
- the model sees `@session:<uuid>` tokens directly; when calling `session_ask`, it should pass only the UUID value

## `/session-index`

The control panel shows:

- index path or `<no index found>`
- schema version
- indexed session count
- `Last full reindex`

Use:

- `r` — request a full rebuild
- `Enter` / `Esc` — close

## Auto-titling

Sessions are automatically titled and retitled as the conversation progresses.

- A lightweight LLM call generates a short, descriptive title from the active branch conversation
- Titles refresh every N turns (default 4), configurable via `sessions.autoTitle.refreshTurns`
- `sessions.autoTitle.model` can pin a specific `provider/modelId`; otherwise `pi-sessions` prefers a small cheap fallback list before using the current session model
- If you manually rename the session, automatic refresh pauses until you run `/retitle`
- Run `/retitle` to regenerate the title on demand and resume automation

```json
{
  "sessions": {
    "autoTitle": {
      "refreshTurns": 4,
      "model": "anthropic/claude-haiku-4-5"
    }
  }
}
```

## Hook-maintained future sessions

After the first full reindex, future sessions stay current through hooks.

The package currently updates on these events:

- `session_start`
  - handles startup, reload, new, resume, and fork lifecycle transitions
- `tool_call`
- `tool_result`
- `turn_end`
- `session_tree`
- `session_compact`
- `session_shutdown`

What that means in practice:

- new text and file-touch evidence becomes searchable without rerunning reindex
- branch summaries and compaction summaries are indexed as they are created
- repo-root membership is recomputed from touched paths during hook flushes

## Failure model

If the sidecar DB is missing or schema-incompatible, `session_search` fails closed and tells you to rebuild.

If hooks were disabled, interrupted, or unavailable for some period, run:

```text
/session-index
```

then press `r` and confirm.

That is the supported repair path. Search does **not** inspect raw session files at query time.

## Search behavior

### `session_search`

Parameters:

- `query?: string`
- `files?: { touched?: string[] }`
- `repo?: string`
- `cwd?: string`
- `time?: { after?: string; before?: string }`
- `limit?: number`

Notes:

- invalid `time.after` / `time.before` values are rejected
- `limit` defaults to `10` and must be greater than `0`
- time filtering uses overlap with the session span from first timestamp to last timestamp
- when called without text or file evidence, results are ordered newest-first
- visible output is grouped by `cwd` to reduce repetition

Visible output includes a compact subset such as:

- `title`
- `session`
- `cwd`
- `matched_files` when applicable
- `score / hits` when applicable
- `snippet` when applicable

### File-touch semantics

`files.touched` matches sessions that either:

- read the file
- edited the file
- wrote the file

Path matching uses normalized absolute, cwd-relative, repo-relative, and basename metadata.

## Follow-up behavior

### `session_ask`

Parameters:

- `session: string`
- `question: string`

`session` must be the session UUID.

Behavior:

- reads and renders the **entire session tree**
- requires a non-empty session UUID and question
- includes the session id, title, and question in both progress updates and the final result
- answers using only that session’s contents
- returns a friendly error when the session id cannot be resolved
- intended as the deep follow-up after `session_search`

## Examples

### Find sessions about a topic

```text
Use session_search with query "session_query" and limit 5.
```

### Find sessions in one repo that touched a file

```text
Use session_search with repo "/Users/thurstonsand/Develop/ansiblonomicon" and files.touched ["chezmoi/private_dot_pi/agent/extensions/parallel-web-tools/fetch.ts"].
```

### Restrict by cwd and time

```text
Use session_search with cwd "/Users/thurstonsand/Develop/ansiblonomicon" and time.after "2026-03-01T00:00:00Z".
```

### Ask one chosen session what happened

```text
Use session_ask with session "2dc89501-5e75-4c75-bc71-15c499d850b2" and ask what decisions were made.
```

### Start a focused child session

```text
/handoff continue the session handoff autocomplete work
```

## Development

```bash
npm run check
npm test
npm run lint
npm run format
```

## End-to-end smoke test

See [SMOKE.md](./SMOKE.md).
