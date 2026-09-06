# Forwarded Subagent Permission Prompts

## Status

Deferred

## Decision Summary

A future optional integration between pi-sessions and pi-permissions may forward approval requests from managed subagents to their owning parent session, where the Approver can answer them through the normal permission UI. The direction is promising but deliberately deferred: request routing, prompt serialization, cancellation, and parent-disconnect behavior form a small RPC protocol and should not be improvised as part of the immediate freeze fix.

## Problem Statement / Background

Pi-sessions runs a subagent in a detached tmux window. Tmux gives the process a PTY, so Pi starts in TUI mode and reports that UI is available even though no human is attached. When pi-permissions receives `request()` from a permission hook, it opens a custom approval prompt and awaits input indefinitely. The subagent consequently appears busy but makes no further progress.

Running subagents in print or JSON mode is not a local fix. Automatic handoff bootstrap currently requires UI mode to generate and deliver the kickoff, and the managed child lifecycle is built around a live Pi session. Inferring authority from tmux attachment is also wrong: attaching merely to observe a worker must not silently change which operations it may perform.

The immediate workaround lives outside either package in the user's permission module. It recognizes pi-sessions' `@pi_session_id` tmux window stamp and makes an explicit allow-or-block decision for each permission hook. This avoids indefinite prompts but is intentionally an integration hack, not a public contract.

The desired later behavior is richer: some permission hooks should still resolve locally for subagents, while selected requests should appear in the parent session so the Approver can authorize, reject, edit, or annotate them without attaching to each worker.

## Goals

- Never leave a managed subagent waiting indefinitely for input in its detached window.
- Preserve per-hook expressivity: permission authors decide which subagent operations are allowed, blocked, or forwarded.
- Present forwarded requests in the owning parent session with clear child, permission, tool, and command attribution.
- Serialize simultaneous requests from multiple children into a comprehensible approval queue.
- Authenticate both directions through pi-sessions ownership and broker identity rather than trusting payload-claimed session ids.
- Bound every wait and define a safe outcome when the parent closes, the child is cancelled, or delivery fails.

## Non-Goals

- Implementing the forwarding protocol as part of the current workaround.
- Making tmux client attachment an authority signal.
- Turning permission outcomes into a general audit log.
- Letting a parent approve requests from arbitrary peer sessions rather than its owned subagents.
- Replacing pi-permissions' ordinary in-session approval flow.

## Exposed Shape

### Permission author policy

A permission author should retain control in hook code. The exact API remains open, but a request made without a local Approver needs three conceptual outcomes:

- **allow locally** — proceed without prompting;
- **block locally** — return a normal blocked tool result so the subagent may adapt or report that it is blocked;
- **forward** — ask the owning parent and await its bounded response.

Pi-permissions should expose the types or helpers that express this policy. Pi-sessions should not independently redeclare permission decisions or prompt payloads.

### Forwarded request

Pi-permissions owns the permission-domain payload. A request needs, at minimum:

```ts
interface ForwardedPermissionRequest {
  requestId: string;
  permissionName: string;
  description: string;
  toolName: string;
  toolDetail: string;
  prompt?: {
    guidance?: string;
    approveLabel?: string;
    editLabel?: string;
    rejectLabel?: string;
    highlight?: unknown;
  };
  editableCommand?: string;
}
```

The exact highlight representation must be transport-safe; callbacks cannot cross the process boundary and would need to be resolved to spans before delivery.

Pi-sessions owns routing metadata and stamps the source identity at the broker boundary. The parent accepts a forwarded request only from an owned child with an active launch on the relevant branch.

### Parent approval queue

The parent presents at most one permission prompt at a time. Forwarded prompts include the subagent title and session id in addition to pi-permissions' normal hook and tool details. Requests from multiple children wait in arrival order unless a later design chooses another explicit policy.

The normal outcomes remain:

```ts
type ForwardedPermissionResponse =
  | { requestId: string; decision: "approve"; note?: string }
  | { requestId: string; decision: "reject"; note?: string }
  | { requestId: string; decision: "edit"; command: string; note?: string };
```

Pi-sessions routes the response only to the requesting child. Pi-permissions applies it to the suspended tool call; edited commands retain the current rule that approval skips hook re-evaluation.

### Failure contract

A forwarded request must have a bounded lifetime. If the parent is unreachable before delivery, disconnects before answering, rejects the source as unowned, or fails to answer before the deadline, the child applies the permission hook's configured unavailable-Approver fallback. The default should fail closed.

A child cancellation or tool-call abort invalidates its queued request. A late response to an expired or cancelled request is ignored.

## Design Decisions

### 1. Subagent authority is explicit, not inferred from terminal state

A managed worker is unattended by launch policy even though it has a TUI and may later be observed. Tmux attachment therefore cannot decide whether prompting is safe. The current window-stamp lookup is acceptable only as an interim user-level workaround; a production integration needs an explicit pi-sessions identity or transport contract.

### 2. Local policy precedes forwarding

Forwarding every request would replace one source of friction with a parent-side prompt flood. Permission authors should be able to allow low-risk operations and block operations that should never be delegated before considering forwarding. Only the unresolved middle reaches the parent.

### 3. Pi-permissions owns permission semantics

Prompt fields, highlights, approve/reject/edit behavior, notes, and unavailable-Approver fallback belong to pi-permissions. It should export the runtime schemas and TypeScript types needed by the integration so pi-sessions does not create a drifting copy.

Pi-sessions owns subagent identity, parent ownership, broker routing, delivery, and lifecycle. The exact optional-dependency mechanism remains open.

### 4. Parent prompts are serialized

Multiple detached children can request approval concurrently, while the parent may also be showing its own local permission prompt. Prompt presentation needs one queue shared or coordinated with the local flow; concurrent overlays are not a valid queue.

### 5. Forwarded approval is ephemeral and bounded by default

An approval is authority over a specific pending tool call, not durable work to replay after either process restarts. Requests and responses should carry unique ids and expirations, and stale responses must be inert. Whether minimal transcript evidence is useful for recovery or presentation remains open, but replaying an approval is not.

## Edge Cases & Failure Modes

- **Parent is closed when the request is created:** Delivery fails immediately and the child applies its unavailable-Approver fallback.
- **Parent closes with requests queued:** Waiting children time out or receive cancellation and apply their fallback; they do not remain busy forever.
- **Child is cancelled while waiting:** Its queue item is removed or marked inert; any later response is ignored.
- **Two children request simultaneously:** The parent shows one prompt and queues the other without opening competing overlays.
- **Parent has a local permission prompt open:** Forwarded requests wait behind it unless the eventual queue design deliberately chooses otherwise.
- **Bash edit is approved:** The edited command returns only to the requesting child and skips hook re-evaluation, matching local behavior.
- **Highlight uses a callback:** The child resolves it to serializable spans before transport.
- **Forged child id in payload:** Ignored; broker-stamped source and active parent ownership are authoritative.
- **Parent is running without a TUI:** Forwarding is unavailable and the child applies its fallback.
- **Response arrives after timeout:** Ignored by request id and terminal request state.

## Alternatives

### Continue using the tmux window stamp in permission modules

- **Status:** Rejected as the long-term integration
- **Decision:** Keep it only as the immediate user-level workaround.
- **Discussion:** It is cheap and precise for current managed windows, but it couples permission policy to a private runtime marker and cannot deliver an approval to the parent.

### Disable pi-permissions for subagents

- **Status:** Rejected
- **Decision:** Preserve hard blocks and per-hook policy rather than removing the entire gate.
- **Discussion:** Disabling all hooks also removes protections that do not require human input and gives no route for genuinely reviewable operations.

### Convert every request to a local block

- **Status:** Open
- **Open Issue:** This is a safe permanent policy for some users and the appropriate default fallback, but it prevents deliberate approval of exceptional subagent operations.
- **Discussion:** The immediate workaround may use this behavior per hook. Forwarding exists to address the cases where a human decision is worth waiting for.
- **Next step:** Revisit after observing which real subagent operations are blocked often enough to justify the protocol.

### Prompt only when a tmux client is attached

- **Status:** Rejected
- **Decision:** Observation must not change authority.
- **Discussion:** Attachment is racy, may occur only to inspect output, and would make identical work behave differently depending on timing.

### Persist and replay unanswered approvals

- **Status:** Rejected
- **Decision:** Approval applies to one live tool call and expires with it.
- **Discussion:** Replaying old authority after a child or parent restart risks executing a command after its context and the Approver's expectations have changed.

## Open Questions for Revisit

- Should pi-permissions depend optionally on a public pi-sessions transport API, should pi-sessions optionally load pi-permissions schemas, or should both compose through a smaller neutral protocol package?
- How should forwarded and parent-local prompts share one queue without coupling pi-sessions to the permission overlay implementation?
- What timeout and cancellation feedback should the parent and child display?
- Should a rejected or expired forwarded request abort the child's turn or return a normal blocked tool result? The immediate recommendation is the latter.
- Is transient broker delivery sufficient, or is a non-authoritative transcript card useful for visibility without enabling replay?
