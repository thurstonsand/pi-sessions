# 10 — Session messaging

## Status

Draft

## Decision Summary

Expose live, agent-facing session-to-session messaging through `session_list_live` and `session_send_message`. The design uses a pi-sessions-native local broker, inspired by `pi-intercom`, but keeps Pi session UUIDs and pi-sessions lineage as the public identity model. Delivery is live-only and best-effort durable: the recipient appends a receipt entry before acknowledging delivery, and replay on session start covers the normal in-memory steering gap.

## Problem Statement

`session_search` and `session_ask` make prior sessions discoverable. `session_handoff` can start a related child session. The missing piece is live coordination between sessions after those sessions exist.

Concrete scenarios:

- A parent starts a background handoff and tells the child to investigate, then report findings back to the parent when complete.
- A child session hits an ambiguity and needs to ask its parent for a decision without leaving its current context.
- Two sibling sessions are working in parallel and need to share discoveries, blockers, or file paths.
- A long-running investigation wants to send meaningful progress to the orchestrating session without forcing the human to manually copy context.

There is an existing package, `pi-intercom`, that proves a local broker model works for direct Pi session communication. It exposes one multiplexed `intercom` tool with list/send/ask/reply/status actions, uses a local socket or named pipe broker, and stores incoming messages in Pi session history. That package is close enough to learn from, but its public identity model is broker runtime ids and names. `pi-sessions` should instead use real Pi session UUIDs, indexed lineage, and the existing `session_*` tool vocabulary.

## Goals

- Let an agent list other live Pi sessions on the same machine.
- Let an agent send a message to another live session by full session UUID.
- Make sent messages start the recipient agent when idle and steer the recipient agent when already running.
- Keep the current session out of the target list.
- Include enough target metadata for an agent to choose a session: id, title, cwd, and lineage relation.
- Preserve delivery evidence in both sender and recipient transcripts.
- Recover received-but-not-yet-injected messages when a recipient session restarts.
- Reconnect broker clients indefinitely while their Pi sessions remain active.
- Let the existing `session_handoff` agent tool request a completion report from the spawned child session.
- Keep v1 live-only; inactive historical sessions remain the domain of `session_search` and `session_ask`.

## Non-Goals

- Human-facing messaging UI, slash command, or shortcut.
- Offline delivery to inactive sessions.
- Cross-machine networking.
- Blocking ask/reply semantics.
- Attachments or file transfer.
- Using session names as primary target identifiers.
- Depending on `pi-intercom` at runtime.
- Directly appending model-visible messages into another session file.
- Distributed live-session caches in every Pi process.
- Query/filter parameters on `session_list_live`.
- `requestResponse` on the human `/handoff` command.

## Exposed Shape

### `session_list_live`

Lists every other reachable session registered with the local broker.

Parameters:

```ts
session_list_live()
```

Semantics:

- No arguments.
- Only live broker-registered sessions are returned.
- The current session is excluded entirely.
- Results are across all directories, not scoped to the current cwd.
- The tool does not search, filter, paginate, or limit in v1. Historical/session discovery remains `session_search`.
- Results include only the metadata needed to choose a target.

Representative result shape:

```ts
{
  sessions: [
    {
      sessionId: "...",
      sessionName: "Research thread",
      cwd: "/path/to/repo",
      relation: "child"
    }
  ]
}
```

The model-facing tool content should be JSON. The TUI renderer can present the same rows more compactly for humans.

### `session_send_message`

Sends a message to another live session.

Parameters:

```ts
session_send_message({
  session: string,
  message: string,
  requestResponse?: boolean
})
```

Semantics:

- `session` accepts only a full Pi session UUID among currently live sessions.
- Empty messages are rejected.
- The current session cannot target itself.
- `requestResponse` is only a hint to the recipient agent. It does not make the sender wait for a reply.
- Success means the target extension accepted the message and appended its receipt entry without throwing.
- The tool returns the message id and target session id.

Representative incoming model-visible content:

```text
Incoming message from session "Research thread" (session: 018f..., relation: child):

<message body>

Response requested.
```

Rules:

- Include source title in quotes only if present. Do not invent a short-id title fallback.
- Always include the full source session UUID.
- Include relation only when the sender is related to the recipient.
- Include the response-requested line only when `requestResponse` is true.
- Full metadata belongs in `details`, not in model-visible content.

### `session_handoff` integration

The existing LLM-callable `session_handoff` tool should gain an optional field:

```ts
session_handoff({
  goal: string,
  splitDirection: "left" | "right" | "up" | "down",
  cwd?: string,
  requestResponse?: boolean
})
```

This is tool-only. The human `/handoff` command does not gain this flag in this design.

When `requestResponse` is true, the generated child prompt should make the reporting expectation explicit in the opening continuity line. Exact wording can be finalized during implementation, but the intent is:

```text
Continuing work from session <uuid>. When you lack specific information you can use session_ask. When this work is complete, send that session a brief completion report with session_send_message.
```

The child handoff prompt should not require blocking ask/reply support. It should simply instruct the child agent to send a normal `session_send_message` back to the parent when appropriate.

## Design Decisions

### 1. Use a pi-sessions-native local broker

Use one local broker process as the authority for live session registration and message routing.

Shape:

```text
Pi session A ─┐
Pi session B ─┼─ local broker process
Pi session C ─┘
```

Each Pi process is a client. The broker is the only server.

Why:

- Pi extension contexts can only send messages into their own live session.
- Direct JSONL writes into another session would not update that session's in-memory agent state or UI.
- Polling SQLite for a mailbox would work, but live coordination wants immediate routing and presence.
- `pi-intercom` has already demonstrated that local IPC is the right broad mechanism.

The broker should be native to this package rather than a dependency on `pi-intercom` because the identity model is different. `pi-sessions` should key everything by real Pi session UUID and augment rows with lineage.

### 2. Broker state is authoritative and queried on demand

Do not distribute live-session lists to every client.

The broker owns the live registry. `session_list_live` asks the broker for the latest state when called. `session_send_message` resolves and routes through the broker when called. The client can enrich returned live rows with lineage relation by consulting the existing session index.

Why:

- It avoids drift between client-side caches.
- There is no v1 live overlay requiring reactive updates.
- Presence broadcasts such as `session_left` are useful for UI caches, but unnecessary for the agent tool surface.
- Lineage enrichment can happen at list/send time; it does not need distributed live-state replication.

The broker may still internally notice socket close and unregister sessions. It does not need to broadcast those changes to clients in v1.

### 3. Register by Pi session UUID

Broker registration must include only the public session metadata needed by the v1 tools:

- session id
- session title, when present
- cwd

The broker also keeps internal connection state such as the socket and liveness timestamps, but it does not need to expose model, pid, status, repo roots, or indexed search data in v1.

The public identity is always the Pi session UUID, not a broker-generated runtime id or a session name.

Why:

- `session_search`, `session_ask`, the picker, and handoff lineage already use Pi session UUIDs.
- UUIDs make cross-references between transcripts and tool results stable.
- Names are useful display metadata, not safe routing identifiers.
- Keeping registration narrow prevents `session_list_live` from becoming a second search surface.

### 4. First duplicate registration wins

If a second process registers the same Pi session UUID while the first connection is still live, the broker rejects the duplicate registration and leaves the first connection as the message target.

The duplicate instance should treat messaging as unavailable and fail its tools clearly.

Why:

- Opening the same session twice is not a supported workflow in Pi.
- Replacing the existing connection could route messages to the wrong surface.
- Marking the target ambiguous would punish the first healthy instance.

If the first process exits or its socket closes, the broker removes it and a later registration can succeed.

### 5. Live-only in v1

`session_send_message` only targets sessions currently registered with the broker.

Why:

- Sending messages to old sessions would create surprising future behavior.
- `session_search` and `session_ask` already cover inactive sessions.
- Live-only keeps delivery semantics honest.

Offline queues can be added later if there is a real workflow that needs them.

### 6. Start or steer the recipient agent

Delivery behavior is fixed, not configurable by tool parameter.

Rules:

- If the recipient agent is idle, inject the message with `pi.sendMessage(..., { triggerTurn: true })` so a new turn starts immediately.
- If the recipient agent is running, inject the message with `pi.sendMessage(..., { deliverAs: "steer" })` so it becomes steering input during the current run.

Why:

- The user's desired behavior is generalized agent-to-agent communication, not passive notifications.
- Steering active work is intentional for this feature.
- A delivery mode parameter would invite inconsistent agent policy too early.

### 7. Use a receipt entry to cover the in-memory steering gap

Before calling `pi.sendMessage`, the recipient appends a non-context custom entry:

```ts
pi-sessions.message_received
```

That receipt contains the full message payload and metadata. If appending the receipt succeeds, the recipient can acknowledge the broker.

Then the recipient calls `pi.sendMessage` with a model-visible custom message:

```ts
customType: "pi-sessions.session_message"
content: "Incoming message from session ..."
display: true
details: fullMetadata
```

Why:

- `pi.sendMessage(..., { deliverAs: "steer" })` queues in memory while the recipient agent is running.
- The queued custom message is persisted only when the steering queue drains and Pi emits `message_end`.
- If the process exits during that gap, the receipt lets the session replay the message on startup.

This is best-effort durability. Do not verify JSONL flushes or add fsync-style ceremony. If `pi.appendEntry` returns without throwing, v1 treats the receipt as accepted.

### 8. The agent-visible custom message is the dispatch proof

No separate `message_dispatched` entry is needed.

On `session_start`, the extension scans current session entries for `pi-sessions.message_received` entries that do not have a matching agent-visible `custom_message` entry:

- `customType === "pi-sessions.session_message"`
- `details.messageId === received.messageId`

Any unmatched receipt is replayed immediately through `pi.sendMessage`.

Why:

- The custom message entry already proves the message reached transcript/model context.
- A separate dispatched tombstone would create another race and more state to reconcile.
- The matching custom message is easier to reason about: if it exists, do not send again.

### 9. Store full metadata outside model context

`pi.sendMessage` custom message `details` are persisted in the session transcript but are not sent to the LLM. Only `content` is converted into LLM context.

Store full metadata in both:

- recipient `pi-sessions.message_received` custom entry
- incoming `pi-sessions.session_message` custom message details

Message metadata should include:

- message id
- source session id/path/title/cwd
- target session id/path/title/cwd
- relation from target to source, when present
- source tool call id
- sent and received timestamps
- `requestResponse`

This is message metadata, not broker registration metadata. The broker only needs the narrow live-session metadata required for listing and routing.

The model-visible prompt should stay small: source title when present, source UUID, relation when present, message body, and optional response-requested hint.

### 10. Sender logs message-sent evidence

After broker acknowledgement, the sender appends:

```ts
pi-sessions.message_sent
```

This is not part of delivery mechanics. It is an audit/cross-reference entry so future `session_ask` answers can identify when one session sent a message and when the target received it.

### 11. `requestResponse` is a hint only

`requestResponse` tells the recipient agent that the sender would appreciate a response. It does not block the sending tool and does not create reply correlation in v1.

Why:

- Blocking ask/reply is useful but larger than the first tool needs.
- The immediate use case is generalized communication and reporting.
- Message ids and metadata preserve enough structure to add correlated replies later.

Do not expose `responseTo` in v1.

### 12. Thread response intent through `session_handoff`

The LLM-callable `session_handoff` tool should accept `requestResponse?: boolean`.

When true, the child-generated handoff prompt should tell the child to report back to the parent session with `session_send_message` when the work is complete. This is a prompt instruction, not a transport-level subscription or blocking wait.

Why:

- The most concrete session-messaging use case starts with a parent launching a child investigation.
- The agent tool can encode this expectation cleanly without adding a human `/handoff` flag.
- It keeps request/response as a social protocol in v1 rather than a correlated transport feature.

### 13. Broker auto-starts and auto-exits

On session start, the extension should ensure the broker is running and then register the session.

The broker exits after the last client disconnects, after a small idle delay. Sessions should keep trying to reconnect indefinitely while active, using a capped backoff that reaches 30 seconds.

Why:

- No long-lived daemon management.
- Matches the successful `pi-intercom` operational model.
- A later Pi session can start the broker again when needed.

Graceful shutdown unregisters. Hard crash is handled by socket close. For wedged connections, enable socket keepalive where available and use broker-level request timeouts so sends fail instead of pretending delivery succeeded.

Broker spawn attempts must go through a filesystem spawn lock so reconnecting Pi sessions do not stampede broker recreation. The lock uses exclusive file creation plus stale-lock detection by pid and age. If one session owns the lock, the rest wait for the socket to become connectable rather than spawning competing brokers.

Reconnect is silent in v1. If the broker is down when an agent calls `session_list_live` or `session_send_message`, the tool should fail clearly while background reconnect continues. A future improvement may inject a model-visible message after reconnect only when a previous tool call failed due to broker unavailability.

### 14. Keep broker connection hidden behind a session messaging service

Tool implementations should not think in terms of broker connections. They should call a `SessionMessagingService` surface:

```ts
listLiveSessions(ctx)
sendMessage(ctx, params)
```

The service owns broker connectivity as an internal detail:

- connect/register on session start
- disconnect/unregister on session shutdown
- reconnect forever while active, capped at 30 seconds
- try an immediate reconnect when a tool call arrives and the client is disconnected
- route incoming broker frames to the incoming-message runtime

The service stores the current session identity needed for reconnect:

- session id
- title, when present
- cwd

This identity is captured on session start and cleared on session shutdown. A separate identity-provider abstraction is unnecessary for v1.

### 15. Limit long-lived context to incoming broker delivery

Tool paths receive fresh `ExtensionContext` from Pi and should use it directly. The only path that needs long-lived context is broker-initiated incoming delivery, because a socket frame can arrive outside any Pi hook or tool execution.

Use a small incoming-message runtime rather than storing raw context in the extension module. This runtime self-registers only lifecycle hooks needed to maintain its context:

- `session_start` attaches the current context
- `session_shutdown` clears it

It exposes only the capability needed by incoming delivery: append the receipt entry, inspect current entries for replay, check idle state, and inject the model-visible custom message. It should not own tool behavior, search/list behavior, broker reconnect policy, or handoff behavior.

Because incoming delivery should be synchronous after a broker frame is received, no generation counter is needed in v1. Generation can be added later if incoming delivery gains async boundaries. Runtime action failures should still be caught so stale-edge races produce a broker nack rather than crashing the socket loop.

### 16. Generate message ids at the source client

The source client should generate `messageId` before sending to the broker, then the broker should route and echo that id. The broker should not be the message-id authority for normal sends.

Why:

- sender, broker, and recipient all share one id from the edge of the send attempt
- future internal retry logic can reuse the same message id
- repeated human/model sends of identical text still get distinct ids
- no content-hash idempotency key is needed

Do not derive message ids from message content. The same text sent at different times can be semantically different.

### 17. Implement the broker in TypeScript on Node's `net` module

The broker should be written in TypeScript and run as a small Node process spawned by the extension.

Why:

- This package is already TypeScript and ships through npm.
- Node's `net` module supports Unix domain sockets and Windows named pipes.
- It can enable socket keepalive with `socket.setKeepAlive(...)` and apply request-level timeouts.
- It avoids compiled Swift/Go binaries, platform-specific build artifacts, and a second toolchain.

The `glimpse-companion` extension in `../ansiblonomicon` is the useful local reference for a simple Node socket companion that exits when no clients remain. `pi-intercom` is the useful reference for request correlation and message routing. `ghosttykitd` is still useful as a liveness reference: it uses explicit write timeouts and socket-path monitoring, but Swift is not the friendliest fit for this npm package.

Use a boring JSON framing protocol. Newline-delimited JSON is enough if every frame is produced with `JSON.stringify`; length-prefixed JSON like `pi-intercom` remains a valid fallback if implementation tests reveal framing edge cases.

Validate every runtime message at both socket edges with TypeBox before dispatching it into typed broker/client code. The broker validates all client frames before mutating registry state or routing messages. The extension client validates all broker frames before using them. Invalid frames should close or reject that request instead of flowing unknown JSON deeper into the system.

## Edge Cases & Failure Modes

- **No broker is running:** session startup or the first tool call attempts to spawn it. If spawn fails, both tools fail clearly.
- **Current session is not registered:** tools fail with messaging unavailable.
- **Duplicate session registration:** broker rejects the duplicate and preserves the first connection. The duplicate instance's tools fail locally.
- **No other live sessions:** `session_list_live` returns an empty result.
- **Target UUID matches nothing:** `session_send_message` fails and suggests `session_list_live`.
- **Target UUID is not full:** the broker does not prefix-match, so the send fails as no live session found.
- **Target is the current session:** reject before sending.
- **Target disconnects before receipt acknowledgement:** send fails; no sender `message_sent` entry is appended.
- **Target appends receipt, acks, then crashes before `pi.sendMessage` persists:** target replays the receipt on next `session_start`.
- **Target already has matching `pi-sessions.session_message`:** startup replay skips it.
- **Recipient is idle:** message starts a new agent turn.
- **Recipient is running:** message is steered into the current run and persisted when the steering queue drains.
- **Recipient has no usable model/auth:** Pi may still persist the incoming custom message before the assistant turn fails. The sender does not wait for the recipient agent to complete work.
- **Broker writes to a wedged socket but no receipt acknowledgement arrives:** send times out and fails.
- **Broker disappears while sessions remain active:** active sessions silently reconnect forever with capped 30-second backoff. Tool calls during the outage fail clearly.
- **Multiple sessions reconnect after broker loss:** the filesystem spawn lock ensures only one process recreates the broker while others wait for the socket.
- **Target socket closes after receipt but before acknowledgement reaches broker:** sender sees delivery failure even though the target may replay the receipt later. This rare ambiguity is accepted in v1.
- **Session title changes after registration:** presence update refreshes broker metadata; stale display metadata is acceptable until the next update.

## Alternatives

### Depend on `pi-intercom`

- **Status:** Rejected
- **Decision or open issue:** `pi-intercom` uses broker runtime ids and session names as its practical targeting model. `pi-sessions` needs Pi session UUIDs, lineage metadata, and `session_*` tools.
- **Retained discussion:** `pi-intercom` strongly validates the local broker, auto-spawn, local socket/named-pipe, and inline custom-message approach.

### SQLite heartbeat and mailbox without a broker

- **Status:** Rejected for v1
- **Decision or open issue:** A SQLite mailbox would fit the existing index stack, but message delivery would be polling-based. Steering another active agent is live IPC, not search/index behavior.
- **Retained discussion:** The receipt/replay model still uses session entries for recovery. A mailbox could be revisited if offline delivery becomes a goal.

### Directly append to another session file

- **Status:** Rejected
- **Decision or open issue:** Direct file append would not update the target session's in-memory agent state or UI. It risks creating two realities: disk has a message, live session does not.
- **Retained discussion:** All model-visible injection must go through the target live extension process.

### Passive notification only

- **Status:** Rejected
- **Decision or open issue:** The desired use cases include asking questions, reporting findings, and steering active work. A notification-only system would not let agents coordinate directly.

### Blocking ask/reply in v1

- **Status:** Deferred
- **Decision or open issue:** Useful, and `pi-intercom` proves it can work, but v1 keeps `requestResponse` as a hint only. Correlated replies can be added later using the message ids already stored in metadata.

### Distributed live-session list in each client

- **Status:** Rejected
- **Decision or open issue:** Clients do not need to maintain their own registry. Querying the broker on demand avoids stale local state and keeps v1 focused on agent tools.

### Query parameters on `session_list_live`

- **Status:** Rejected
- **Decision or open issue:** Live-session listing should be a small target-discovery tool, not another search surface. It takes no arguments and returns all other live sessions with id, title, cwd, and relation.
- **Retained discussion:** If live-session counts become large enough to need filtering, that is evidence for a separate UI or a later v2. Current workflows should use `session_search` for historical discovery and `session_list_live` for current reachable targets.

### Swift or Go broker

- **Status:** Rejected
- **Decision or open issue:** Swift and Go are good socket languages, but they introduce extra build/distribution complexity for an npm package whose extension code is already TypeScript.
- **Retained discussion:** `ghosttykitd` remains useful for liveness ideas such as write timeouts and socket-path monitoring. The broker itself should be TypeScript unless Node's socket support proves insufficient.

## Implementation Plan

- [ ] Phase 1: Core live messaging
  - Goal: Ship the live-only broker, `session_list_live`, `session_send_message`, receipt/replay, TypeBox socket validation, Node 24 TypeScript broker process, and `session_handoff.requestResponse` prompt integration.
  - Files: `extensions/session-messaging.ts`, `extensions/session-messaging/**`, `extensions/session-handoff.ts`, `extensions/session-handoff/extract.ts`, `extensions/session-handoff/metadata.ts`, `package.json`, broker tests.
  - Work: Add shared broker/client protocol, broker spawn locking, live registration, duplicate registration rejection, send/list tool surfaces, incoming receipt persistence, model-visible message injection, startup replay, and source-generated message ids.
  - Validation: `npm run check`; tmux smoke with two live Pi sessions listing and sending messages.

- [ ] Phase 2: Reconnect awareness message
  - Goal: If an agent tries to list/send while messaging is unavailable, and the broker connection later recovers, inject a concise model-visible message that session messaging is available again.
  - Files: session messaging service/connection manager and incoming-message renderer areas.
  - Work: Track whether a tool call failed due to broker unavailability; continue silent reconnect attempts; on successful reconnect, emit a single follow-up/steering message only when a prior failure occurred. Do not emit reconnect messages for background disconnects the agent never observed.
  - Validation: Simulate broker death, confirm tool failure, restart/reconnect, and confirm exactly one recovery notice appears; confirm no notice appears when no tool observed the outage.

- [ ] Phase 3: Correlated ask/reply, if needed
  - Goal: Add blocking request/response only if real workflows demand it.
  - Files: protocol, client, tools, incoming renderer, receipt metadata.
  - Work: Add explicit reply correlation and pending request handling without changing v1 `requestResponse` hint semantics.
  - Validation: Multi-session smoke where sender waits for a recipient reply and resumes with the response.
