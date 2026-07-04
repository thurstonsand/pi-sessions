# Context

- **Pi Sessions**: The Pi extension package in this repo; manages recall, lineage, and coordination between Pi coding sessions.
- **Current/active session**: The Pi session handling the current command, tool call, hook, or user prompt.
- **Live/reachable session**: A Pi session with a currently running extension, able to receive a message from another session.
- **Message broker**: The singleton local process that owns live-session presence and routes messages between live sessions. It knows session ids only; all session metadata lives in the session index.
- **Session lineage**: The self/parent/child family relationship between sessions, including ancestors, descendants, siblings, and related branches. Lineage may come from Pi forks or pi-sessions handoffs.
- **Session index**: The local, rebuildable store derived from Pi session transcripts; contains session metadata, searchable text, file-touch evidence, and lineage data. Not the source of truth.
- **Rank**: The ordering of session results by relevance, recency, and contextual priority.
- **Session reference**: An `@session:<uuid>` token inserted into a prompt to refer to a specific prior session. Tools that consume the reference should use the bare UUID value.
- **Session reference picker**: The interactive picker opened from the prompt editor to find a prior session and insert its session reference.
- **Handoff**: A transfer of work from one session into a new child session using a generated prompt based on the current session's context.
- **Handoff draft**: The generated prompt proposed for a handoff before the user accepts or edits it.
- **Background handoff**: A handoff launched into a new Ghostty split while the current session remains focused.
- **Auto-title**: A generated session name based on the session conversation, refreshed over time unless the user manually renames the session.
