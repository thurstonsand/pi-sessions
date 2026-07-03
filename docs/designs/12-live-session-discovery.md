# Live Session Discovery via Session Search

## Status

Accepted

## Decision Summary

Remove the `session_list_live` tool, expose liveness as a `live: true` filter on `session_search`, and shrink the message broker to a pure presence-and-routing table keyed by session id. Session metadata — names, cwds, lineage — comes exclusively from the session index; the broker stops being a third, staler copy of it. This is a deliberate hard break of the broker protocol with no backwards compatibility or migration.

This design supersedes the discovery surface of `docs/designs/10-session-messaging.md` (Decision 2 and the `session_list_live` exposed shape). Doc 10 remains the record for delivery semantics: registration lifecycle, receipts, replay, and steering are unchanged.

## Problem Statement / Background

`session_list_live` exists only to answer "which sessions can I message right now." It returns bare broker rows — id, name-at-registration, cwd — while `session_search` returns richer, ranked, index-backed results for the same sessions. Doc 10 Decision 3 already warned against `session_list_live` "becoming a second search surface"; the clean end state of that logic is that it should not be a search surface at all.

The broker's metadata is also the weakest copy in the system. `sessionName` is captured once at `register` time (`buildSessionInfo`, `service.ts:291`), so a session renamed by auto-title delivers messages and appears in listings under its startup name. Meanwhile the index is refreshed on every `turn_end` hook sync, which re-extracts `session_info` entries — the index name lags a rename by at most one turn boundary. Verified consumers of broker metadata are exactly three: the `sessions` list frame (feeds only `session_list_live`), the `source.sessionName` field of message payloads (read only in `incoming-runtime.ts` for display), and the `registered` echo. Routing itself (`resolveTarget`) is a pure id-to-socket lookup.

Concrete scenario: session A is auto-titled from "[untitled]" to "Fix search ranking" three turns in, then messages session B. Today B renders "Incoming message from session" with no title or the stale one. After this design, B annotates the receipt from the index at delivery time and records the current title durably.

## Goals

- One discovery surface: finding a live session is a `session_search` call, inheriting ranking, filters, and index metadata.
- The broker stores nothing but session ids and sockets; it can never serve stale metadata because it serves none.
- Durable receipts in the session file remain self-contained, carrying the sender's name and cwd as known at delivery time.
- Search results carry the lineage relation to the current session — for all results, live or not.
- Fewer tools exposed to the model.

## Non-Goals

- No backwards compatibility for the broker protocol, no version negotiation, no migration of in-flight state. The user kills the old broker process.
- No graceful degradation modes beyond clear errors: `live: true` with messaging inactive fails loudly (consistent with doc 10's broker-down stance).
- No change to delivery semantics: registration lifecycle, first-registration-wins, receipts-before-ack, replay, and steering behavior from doc 10 are untouched.
- No liveness annotation on ordinary (non-`live`) searches; liveness is a filter, not a result field.

## Exposed Shape

### `session_search` additions

```ts
{
  // ...existing params from doc 11...
  live?: boolean;   // true = only sessions currently registered with the broker; false ≡ absent
}
```

`live: true` intersects with all other filters (query, files, repo, cwd, time). The current session remains excluded, matching both predecessors.

Results gain a lineage field, populated for every result relative to the current session:

```ts
{
  // ...existing result fields...
  relation?: "parent" | "ancestor" | "child" | "descendant" | "sibling" | "ancestor_sibling";
}
```

### Removed

`session_list_live` is deleted. `session_send_message`'s guideline changes from "Use session_list_live to discover targetable sessions" to pointing at `session_search` with `live: true`.

### Broker protocol (breaking)

- `register` carries `{ sessionId }` only; `registered` echoes the id.
- `list` response carries `sessionIds: string[]`.
- Message payloads carry `source` and `target` as bare session ids. `body`, `messageId`, `sentAt`, `requestResponse`, `sourceToolCallId` are unchanged.

### Durable receipt entry

The receipt keeps a self-contained shape — `source: { sessionId, sessionName?, cwd? }` — but the receiver populates name and cwd from the session index at delivery time, before appending the receipt. Fields are absent when the source is unknown to the index.

## Design Decisions

### 1. Liveness is a search filter, not a tool

The live-session listing becomes `session_search` with `live: true`: fetch the live id set from the broker, and constrain the candidate set to those ids (the SQL `session_id IN (...)` machinery from doc 11's file-filter path already exists). Live results inherit everything the index knows — titles, handoff metadata, first prompts, ranking — where the old tool returned bare broker rows.

Tradeoff: a search call with `live: true` now performs one broker roundtrip before querying SQLite. The roundtrip only happens when the filter is requested; ordinary searches never touch the socket.

### 2. The broker stores session ids and sockets, nothing else

The registry becomes `Map<sessionId, socket>`. All metadata fields disappear from the protocol frames. The first-registration-wins conflict check (doc 10 Decision 4) is id-based and survives unchanged.

This removes the stale-name bug by construction: the broker cannot serve stale metadata because it has none. The index — already refreshed every `turn_end` — is the single metadata source.

### 3. The live filter rides the existing registered connection

No observer mode, no second socket. The messaging extension registers on startup and unregisters on shutdown exactly as today; the `list` request is the same request it has always been. What changes is access: the broker client (connection, protocol, socket path) moves to `extensions/shared/`, and the messaging extension publishes its active connection through a process-wide accessor that `session_search` consumes. Extensions in this package share a process, so a shared module singleton is sufficient.

If the messaging extension is not active or the broker is unreachable, `live: true` throws a clear error — the doc 10 stance ("the tool should fail clearly") applied to the new surface. It does not silently return zero results, because "no live sessions" and "cannot ask" are different answers.

### 4. The receiver annotates receipts from the index

Message payloads carry bare ids. On delivery — before writing the durable receipt — the receiver looks up the source's name and cwd in the session index and writes them into the receipt entry. The receiver already opens the index per incoming message for the lineage relation (`getCachedRelationTo(source, true)`); the metadata lookup rides the same access.

This keeps two properties that pure-id receipts would lose: the session file stays self-contained (a receipt is readable years later without an index), and the recorded name is the name *at delivery time* — fresher than today's registration-time snapshot, and honest as a historical record.

Tradeoff: delivery display gains an index dependency. A source unknown to the index degrades to a bare session id in the receipt and the rendered message. Sessions are indexed at `session_start`, so this gap is nearly nil in practice.

### 5. Lineage relation generalizes to all search results

The old tool annotated live rows with their lineage relation. Rather than porting that as a live-only field, `session_search` annotates every result with its relation to the current session, computed from the existing `getLineageRelationMap`. A dead parent session is exactly as relevant to recall as a live one.

The session reference picker already computes this same map for its markers and priorities; it should consume the annotation from results instead of duplicating the lookup.

### 6. Hard break, executed as deletion

No protocol versioning, no dual-shape parsing, no shims. The old broker process is killed by hand. Pending receipts written in the old payload shape are silently skipped by the existing `safeParseTypeBoxValue` replay path — an accepted, bounded loss (undelivered messages from before the upgrade, in a single-user system).

The one ordering consequence: the broker shrink lands *after* `session_list_live` is deleted, so no phase ships a tool whose output degraded under it. See the implementation plan.

## Edge Cases & Failure Modes

- **`live: true` with messaging inactive or broker unreachable:** Throw a clear error naming session messaging as the missing piece. Do not return empty results.
- **`live: true`, broker up, no other sessions registered:** Empty result set — a true answer, not an error.
- **Live session missing from the index:** Invisible to `live: true` results (the filter intersects with index candidates). Sessions are indexed at `session_start`, so this requires an index wipe mid-session; rebuild-and-retry is the existing remedy.
- **Incoming message from a source unknown to the index:** Receipt and display carry the bare session id; optional metadata fields stay absent.
- **Old-format pending receipts at replay:** `safeParseTypeBoxValue` skips them; the message is not re-injected. Accepted loss under the hard break.
- **Duplicate registration:** First registration wins, unchanged from doc 10 Decision 4.
- **`live: false`:** Treated identically to absent. No "not-live" filter exists.
- **Auto-title rename freshness:** Index name lags a rename by at most one `turn_end` sync; receipts and live results read the index, so they are at worst one turn stale — strictly fresher than the registration-time snapshot they replace.

## Alternatives

### Observer (unregistered) `list` connections

- **Status:** Rejected
- **Decision or open issue:** The live filter uses the messaging extension's existing registered connection via a shared accessor. An observer mode would add a protocol concept with exactly one consumer that already has a better path.
- **Retained discussion:** If a future consumer needs liveness without a registered session (an external CLI, say), an unauthenticated read-only `list` is the natural extension point.

### Sender-supplied metadata in the send frame

- **Status:** Rejected
- **Decision or open issue:** The sender could attach its own current name/cwd to each send, keeping receipts self-contained without an index lookup. Receiver-side index annotation won because it uses infrastructure the receiver already exercises per message, keeps frames minimal, and behaves identically for every future frame type without each one growing metadata fields.
- **Retained discussion:** Sender-supplied names are also fresh; this was a close call decided by "rely on the broker strictly for communication, and on the index for metadata."

### Keep `session_list_live` as a thin alias over the search path

- **Status:** Rejected
- **Decision or open issue:** Two tools answering one question costs model prompt budget and invites drift. The send-message guideline redirect covers discoverability.

### Liveness as a result annotation on every search

- **Status:** Rejected
- **Decision or open issue:** Annotating all results would put a broker socket roundtrip on the hot path of every search for information rarely wanted. Filter semantics keep the cost opt-in.

## Implementation Plan

- [ ] Phase 1: Broker client prefactor into shared
  - Goal: The broker connection, protocol schemas, framing, and socket path live under `extensions/shared/`, with a process-wide accessor for the active connection. Zero behavior change.
  - Files: `extensions/session-messaging/shared/*` → `extensions/shared/session-broker/`; `extensions/session-messaging/pi/client.ts` → shared; new accessor module (`setActiveBrokerConnection`/`getActiveBrokerConnection`); import updates in `extensions/session-messaging/pi/service.ts` and broker process; `test/session-messaging.broker.test.ts` import paths
  - Work: Move the modules verbatim, register the active connection in `SessionMessagingService.start`/`stop`, keep all frame shapes untouched.
  - Validation: `npm run check`; broker tests pass unmodified apart from imports.

- [ ] Phase 2: Lineage relation on search results
  - Goal: Every `session_search` result carries `relation` relative to the current session; the picker consumes it instead of computing its own map.
  - Files: `extensions/shared/session-index/common.ts` (result type), `search.ts` (accept a `relativeToSessionId`, annotate from `getLineageRelationMap`), `extensions/session-search.ts` (pass current session id), `extensions/session-handoff/query.ts` (consume `result.relation`, drop duplicate map building); `test/session-search.tool.test.ts`, `test/session-handoff.picker.test.ts`
  - Work: One lineage-map lookup per search, annotation in result shaping, picker markers/priorities read the annotation.
  - Validation: `npm run check`; picker tests confirm identical markers/ordering; tool output shows `relation` for a handoff child in a real search.

- [ ] Phase 3: `live` filter and `session_list_live` removal
  - Goal: `session_search` accepts `live: true`; `session_list_live` is gone; the send-message guideline points at the search tool.
  - Files: `extensions/session-search.ts` (param, broker id fetch via shared accessor), `extensions/shared/session-index/search.ts` (live id set constrains candidates via the existing allowed-ids clause), `extensions/session-messaging/pi/tools.ts` (delete list tool, update guideline), `extensions/session-messaging/pi/service.ts` (drop `listLiveSessions`); tool tests
  - Work: Fetch live ids over the registered connection when `live: true`; throw a clear error when messaging is inactive; intersect ids with candidates; exclude current session (already handled); delete the tool and its formatters.
  - Validation: `npm run check`; live smoke with two real Pi sessions — `live: true` returns the other session with index metadata and relation; messaging-inactive case throws the expected error.

- [ ] Phase 4: Broker and protocol shrink
  - Goal: Broker stores `Map<sessionId, socket>`; all frames carry bare ids; receipts are annotated by the receiver from the index.
  - Files: `extensions/shared/session-broker/protocol.ts` (id-only frames), broker `process.ts` (registry, `handleSend` stops attaching source info), `client.ts`, `extensions/session-messaging/pi/service.ts` (identity = id), `incoming-runtime.ts` + `message-contracts.ts` (receipt enrichment from index before `appendEntry`, optional `sessionName`/`cwd`), `message-view.ts`; broker tests
  - Work: Shrink schemas, delete `buildSessionInfo` metadata, add the index lookup (name, cwd) alongside the existing relation lookup at delivery, keep receipt fields optional for unknown sources.
  - Validation: `npm run check`; broker tests cover id-only register/list/send round-trip; live smoke — rename a session via auto-title, send a message, confirm the receipt and rendered message carry the post-rename title; kill any old broker process first.
