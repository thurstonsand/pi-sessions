# pi-sessions

`pi-sessions` turns your old Pi sessions into something you can actually reuse. It gives you search, follow-up Q&A, deliberate handoffs into new child sessions, automatic session titles, and a local index that keeps future sessions searchable.

## Screenshots

### Session lookup

![session picker](images/session_picker.png)

### Handoffs

![handoff preview](images/handoff.png)

### Ask about old sessions

![session_search tool](images/session_search.png)

![session_ask tool](images/session_ask.png)

## Install

Requires Pi `0.80.2` or newer and Node `>=24 <26`.

**From npm** (recommended):

```bash
pi install npm:pi-sessions
```

If you want to run directly from a local clone while developing:

```bash
pi -e /absolute/path/to/pi-sessions
```

## Quick start

1. Install the package.
2. Open Pi and run `/session-index`.
3. Press `r` to build the index for all your prior sessions.
4. Try the main flows:

```text
What session did I implement the db layer?
```

```text
/handoff i want to implement the frontend component now
```

## Features

| Extension          | Surface                               | What it does                                            |
| ------------------ | ------------------------------------- | ------------------------------------------------------- |
| Session Search     | `session_search` pi tool              | Search through old sessions                             |
| Session Ask        | `session_ask` pi tool                 | Ask questions about old sessions                        |
| Session Handoff    | `/handoff`, `session_handoff` pi tool | Start a focused new session; alternative to compaction  |
| Session Messaging  | `session_send_message` pi tool        | Send messages between running Pi sessions               |
| Session Picker     | `Alt+O`                               | Reference old sessions in your prompt                   |
| Session Index      | `/session-index` slash command        | Shows index status and rebuilds the local session index |
| Session Auto Title | in background, `/title` slash command | Give sessions titles                                    |

## Session Search

`session_search` searches the local session index by text, repo, cwd, time range, file evidence, and whether a session is currently running.

Queries support regular text for normal usage, quoted phrases, `AND` / `OR` / `NOT`, parentheses, and `-term` negation when matching needs to be stricter. Unquoted terms use prefix matching, quoted terms are exact. A search with no query returns matching sessions chronologically, newest first. Use `live: true` to restrict results to currently running sessions.

File filters distinguish read-or-write evidence from write-only evidence:

- `files.touched`: sessions that read or changed a path
- `files.changed`: sessions that changed a path

## Session Handoff

`/handoff <goal>` starts a focused new session. Give pi a goal, and it will generate a prompt for you to review before kicking it off.

You can start a new session directly in your current one, hand it off detached, or — with Ghostty on macOS — spawn it in a split-pane and continue where you are:

- `/handoff --left <goal>`
- `/handoff --right <goal>`
- `/handoff --up <goal>`
- `/handoff --down <goal>`
- `/handoff --detached <goal>`

The direction flags indicate the Ghostty split. `--detached` creates the child session without launching it and copies its resume command to the clipboard, so it works anywhere.

By default the child inherits the current model and thinking level. Override per handoff with `--model provider/id[:thinking]`:

- `/handoff --model anthropic/claude-sonnet-4-5:high <goal>`

Flow:

- run `/handoff [--<direction>] [--model <provider/id>] <goal>`
- review the generated prompt preview
- optionally edit the prompt
- start the new session

If you do nothing, the preview autostarts after a short countdown.

pi-sessions also exposes a `session_handoff` tool so the agent can fork a background session on its own. The current session keeps running while the child gathers context and shows the same review countdown before starting.

If background handoffs ever target the wrong pane, run `/handoff --identify` from the intended source pane to refresh the in-memory Ghostty terminal binding.

## Session Messaging

Agents can coordinate with other currently running Pi sessions:

- `session_search` with `live: true` lists live sessions
- `session_send_message` sends a message to another live session

Incoming messages start the recipient agent when idle and steer it when already running. Inactive sessions cannot receive messages, but you can still use `session_search` and `session_ask` with them.

## Session picker

Directly reference prior sessions by looking them up by contents.

- shortcut: `Alt+O`
- press `Tab` to switch between current folder and all sessions
- type to filter results
- press `Enter` to insert a session id into your prompt

### Handoff setting

If you want to override the shortcut, put this in your `~/.pi/agent/settings.json`:

```json
{
  "sessions": {
    "handoff": {
      "pickerShortcut": "alt+p",
      "detached": {
        "copyToClipboard": true
      }
    }
  }
}
```

`detached.copyToClipboard` (default `true`) controls whether detached handoffs copy the resume command to the clipboard. When off, the resume command is only shown in the notification.

## Session Index

By default, `pi-sessions` will start indexing all conversations moving forward. If you want to backfill all prior conversations:

- run `/session-index`
- hit `r` to (re)index everything

this is idempotent, so if you run into any issues, or disable pi-sessions for a while, feel free to re-index to see if that resolves anything.

By default the index lives at:

```text
~/.pi/agent/pi-sessions/index.sqlite
```

but you can change the location in `~/.pi/agent/settings.json`:

```json
{
  "sessions": {
    "index": {
      "dir": "~/.pi/agent/pi-sessions"
    }
  }
}
```

## Session Auto Title

The auto-title extension keeps your session list readable by:

- Setting a title based on initial prompt
- Reevaluating the title every 4 turns to see if it should be updated

To manage existing titles, run `/title`, where you can:

- Regenerate a title for the current session
- Generate titles for all sessions in the folder
- Generate titles for all sessions across pi

![session title window](images/session-title.png)

Note that generating titles for all sessions can take some time, and will hit your configured model with the full contents of all sessions.

- automatic retitles run every few turns
- if you manually rename a session with `/name`, automatic retitling pauses for that session
- Regenerate the title for the current session to resume automatic retitling
- if unconfigured, it will attempt to use these models in order, first one that is available:
  - `google/gemini-flash-lite-latest`
  - `anthropic/claude-haiku-4-5`
  - `openai/gpt-5.4-mini`
  - your currently configured model

To change auto-titling settings, edit `~/.pi/agent/settings.json`:

```json
{
  "sessions": {
    "autoTitle": {
      "refreshTurns": 4,
      "timeoutSecs": 15,
      "model": "anthropic/claude-haiku-4-5",
      "prompt": "Custom prompt that overrides the default."
    }
  }
}
```

## Development

```bash
npm install
npm run check
npm test
```

For an end-to-end manual flow, see [SMOKE.md](./SMOKE.md).
