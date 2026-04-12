# 07 — Session reference picker

## Problem Statement

`pi-sessions` needs a lightweight way to insert canonical session tokens into an in-progress prompt without depending on prompt-editor autocomplete, Powerline integration, or private editor behavior.

The UI should:

- open while the user is already drafting
- preserve the current draft and live cursor context
- let the user browse and search prior sessions
- insert `@session:<uuid>` at the current cursor
- stay aligned with the same indexed session universe and ranking strategy already used for session references
- keep the implementation as small and simple as possible

The backend contract stays the same:

- canonical inserted form: `@session:<uuid>`
- `session_ask` still accepts only the bare UUID
- the sidecar index remains the source of truth for session-reference discovery

## Design Summary

Build a small, package-owned, read-only session picker opened from a dedicated shortcut.

The picker is:

- overlay-based
- index-backed
- insert-only in v1
- visually modeled on Pi’s `/resume` picker
- not implemented by reusing Pi’s `SessionSelectorComponent` directly

We should borrow the good parts of `/resume`—overall layout, keyboard feel, and threaded lineage display in browse mode—without taking a runtime dependency on its opinionated selector component.

Reference implementation in Pi:

- picker component: `node_modules/@mariozechner/pi-coding-agent/dist/modes/interactive/components/session-selector.js`
- search behavior: `node_modules/@mariozechner/pi-coding-agent/dist/modes/interactive/components/session-selector-search.js`
- `/resume` entrypoint: `node_modules/@mariozechner/pi-coding-agent/dist/modes/interactive/interactive-mode.js`

## Design Decisions

### 1. Use a package-owned picker, not `SessionSelectorComponent`

Pi’s built-in `SessionSelectorComponent` is the wrong runtime dependency for this flow.

It is optimized for session switching, not reference insertion. It bundles behavior and UI we do not want in this picker, including resume-oriented labeling and mutation affordances.

For this feature, the simplest correct plan is:

- build a small picker component owned by `pi-sessions`
- model it on `/resume`
- copy only tiny rendering ideas/helpers if useful
- do not instantiate Pi’s built-in session selector directly

This keeps the code under our control while still preserving the familiar look and interaction style.

### 2. Use an overlay, not editor replacement

The picker should open through `ctx.ui.custom(..., { overlay: true })`.

Use:

- `ctx.ui.custom(...)` with `overlay: true`
- `ctx.ui.pasteToEditor()` for insertion

Do not temporarily replace the editor component for this flow.

The overlay approach is the simplest way to preserve the current draft and insert into the live editor afterward without taking on cursor-restoration work.

### 3. Keep the picker index-backed

The picker should use the same indexed session-reference strategy that already powers session token discovery.

Do not use `SessionManager.list(...)` / `listAll(...)` as the picker’s data source.

Reasons:

- the picker should list the same sessions that `session_ask` can later address through the index
- current ranking and relationship-aware ordering already live in the indexed query layer
- handoff metadata, snippets, and other indexed presentation fields remain available
- one backend is simpler than splitting selection and recall across different sources of truth

### 4. Keep v1 read-only

The picker is read-only in v1.

Supported actions:

- `Enter` inserts `@session:<uuid>`
- `Esc` cancels
- `Tab` toggles scope if we keep a two-scope view

Not supported in v1:

- delete
- rename
- switch session
- any other session mutation

This keeps the implementation tight and avoids stale-index and destructive-action complexity.

### 5. Preserve the current listing and ranking strategy

The items shown in the picker should follow the same strategy they already do today for session references.

That means:

- keep current scope behavior
- keep current relation-aware ordering
- keep current ranking/search behavior
- keep the current session-reference token contract

The picker is a frontend replacement, not a new ranking model.

### 6. Browse mode is threaded; search mode is flat

The picker should have two presentation modes:

#### Browse mode

When the query is empty:

- show a threaded lineage view over the displayed session subset
- keep relationship-aware ordering and current scoping behavior
- make the current session and nearby related sessions easy to spot
- cap visual tree depth so long handoff chains stay readable while preserving row order

Visual shape:

```text
Parent session
├─ Sibling session
└─ This session
   └─ Child session
```

If a chain keeps going deeper than the visual depth cap, keep the ordering but stop increasing indentation.

#### Search mode

When the query is non-empty:

- switch to a flat ranked list
- keep the same underlying indexed ranking behavior
- keep relationship badges/markers on rows

This mirrors the strongest part of `/resume` without forcing search results into an awkward partial tree.

### 7. Use simple row markers

The picker should keep row markers simple.

Display markers should include only:

- `current`
- `parent`
- `child`
- `sibling`
- a short UUID prefix for anything that is not one of the above

We should not expose increasingly remote labels such as `ancestor`, `descendant`, or `ancestor_sibling` in the picker UI.

Important distinction:

- the tree shape shows actual parent/child structure among displayed rows
- the marker gives a small amount of local context relative to the current session

This keeps the UI readable even when the displayed subset is incomplete or the lineage is deep.

### 8. Do not synthesize missing tree nodes in v1

The picker should render a threaded view only across the rows it is already displaying.

If a parent or ancestor is outside the current scope or filtered out, do not create synthetic placeholder nodes.

In that case:

- show the visible row where it belongs in the displayed subset
- keep the relationship marker so the user still has context

This is simpler and avoids special-case tree fabrication logic.

### 9. Keep search syntax minimal in v1

The picker should keep the current query behavior in v1.

Do not add `/resume`-specific search syntax such as regex mode just to mimic the built-in selector.

The v1 rule is:

- keep current indexed search behavior as-is
- document richer syntax only when it is intentionally added to the shared query layer

If quoted phrase support is added later, it should be a small additive improvement to the same indexed backend rather than a picker-specific search language.

### 10. Use a shared compact relative-time formatter based on `Intl`

The picker should show compact relative times in the same style as Pi’s `/resume` picker UI in `node_modules/@mariozechner/pi-coding-agent/dist/modes/interactive/components/session-selector.js`, but we should rely on JavaScript’s built-in relative-time formatting instead of maintaining a handwritten formatter.

Use `Intl.RelativeTimeFormat` and apply two display tweaks:

- show `now` for anything under one minute old
- remove trailing ` ago` from past-time strings so the picker shows compact values such as `7m` instead of `7m ago`

Extract this into a small shared helper so the picker and any other session-reference presentation code can share one formatter.

## Proposed UI

### Browse mode

```text
─────────────────────────────────────────────────────────────────────────────────────────────

Add Session Reference to Prompt (Current Folder)       ◉ Current Folder | ○ All
enter add to prompt · esc cancel · tab scope

>

  Parent session for selector and picker work                      parent  · 197 24m
  ├─ Session reference selection component notes                   sibling · 125 1d
› └─ Adversarial review of session handoff selector reuse docs     current  · 135 7m
      └─ Unified Search and Autocomplete for Session Handoff       child    · 581 11h
  Incorporating TypeScript coding standards into AGENTS.md         8f02c1a7 ·  10 1d
  (1/69)

─────────────────────────────────────────────────────────────────────────────────────────────
```

### Search mode

```text
─────────────────────────────────────────────────────────────────────────────────────────────

Add Session Reference to Prompt (Current Folder)       ◉ Current Folder | ○ All
enter add to prompt · esc cancel · tab scope

selector reuse

› Session reference selection component notes                   sibling · 125 1d
  Adversarial review of session handoff selector reuse docs     current  · 135 7m
  Parent session for selector and picker work                   parent   · 197 24m
  (1/4)

─────────────────────────────────────────────────────────────────────────────────────────────
```

Notes:

- The right-hand numeric column from `/resume` is still useful: it is `messageCount` plus compact relative modified time.
- Search-mode rows may highlight matched text in either the title or the snippet. If the chosen snippet duplicates the title, highlight the title and omit the duplicate snippet row.
- In browse mode, related sessions should appear in a real tree over the displayed rows rather than as isolated one-off indented rows.
- We do not need sort toggles, delete, rename, path toggles, or other mutation hints in v1.
- The title and legend should clearly describe adding a session reference to the prompt, not resuming.

## Integration Points

### `extensions/session-handoff.ts`

Primary integration point.

Responsibilities:

- register one dedicated shortcut such as `Alt+O`, with a simple setting override for users who want a different key
- open the picker overlay
- insert the selected canonical token with `ctx.ui.pasteToEditor()`
- keep the existing `before_agent_start` system-prompt note for `@session:<uuid>` tokens
- remove the old autocomplete-installation logic entirely

### `extensions/session-handoff/picker.ts`

New package-owned UI module.

Responsibilities:

- manage browse/search state
- manage scope toggle state
- render threaded browse mode and flat search mode
- handle selection/cancel keyboard behavior
- return the selected session id to the caller

This module should stay focused on UI state and rendering.

### `extensions/session-handoff/query.ts`

Keep this as the package-owned session-reference query/presentation layer, but reshape it around picker rows instead of autocomplete rows.

Responsibilities:

- canonical `SESSION_TOKEN_PREFIX`
- relation-aware ordering and markers
- display-title/context selection
- thin picker-row shaping for browse/search modes

If it becomes cleaner, split picker-row shaping into a dedicated file such as `picker-query.ts` while keeping the underlying query logic shared.

### `extensions/shared/session-index/*`

Keep this as the indexed backend.

Responsibilities for the picker:

- scope filtering
- ranked search
- lineage/session metadata lookup
- any parent/child metadata needed for threaded browse rendering

If browse-mode threading needs a slightly richer row shape than the current query returns, extend the indexed row shape instead of introducing a second backend.

### `extensions/shared/time.ts`

Add a tiny shared relative-time formatter.

Responsibilities:

- use `Intl.RelativeTimeFormat`
- return `now` for `< 1 minute`
- return compact past-time strings without trailing ` ago`

## Edge Cases

### Missing or incompatible index

The picker should still open.

In that state:

- show a simple error/empty-state panel
- explain that the session index is missing or incompatible
- direct the user to `/session-index` to rebuild it
- disable insertion while in that state

### No matches

Keep the picker open and show an explicit empty state.

Do not fall through to any other editor behavior.

### Current session in results

If the current session appears, mark it clearly as `current`.

Insertion is still allowed.

### Partial tree due to scope or filtering

Render only the displayed rows.

Do not fabricate hidden ancestors or siblings.

Keep relationship badges so the user still understands where the row sits relative to the current session.

### Large session sets

Use the existing indexed scope/ranking strategy and bounded rendering.

The picker should stay lightweight and never attempt to render unbounded preview content.

### Draft preservation

Because the picker is an overlay and insertion happens afterward through `pasteToEditor()`, cancel should leave the prompt untouched and selection should insert into the current draft.

## Rejected Alternatives

### Reuse Pi’s `SessionSelectorComponent` directly

Rejected because it is the wrong abstraction for this flow.

We want the look and some of the interaction ideas, not the full built-in component with its bundled behavior and backend assumptions.

### Keep prompt-editor autocomplete

Rejected because it adds avoidable editor/autocomplete lifecycle complexity for a problem that is better solved by an explicit picker.

### Use raw `SessionManager.list(...)` / `listAll(...)`

Rejected because it splits session selection from the indexed session-reference backend already used by `session_ask` and current ranking logic.

### Add mutation actions in v1

Rejected because read-only insertion is the smallest correct feature.

## Implementation Plan

### Phase 1 — remove the autocomplete frontend completely

- [ ] Remove `extensions/session-handoff/autocomplete.ts`
- [ ] Remove `extensions/session-handoff/powerline.ts`
- [ ] Delete autocomplete-installation logic from `extensions/session-handoff.ts`
- [ ] Remove autocomplete hint widget usage and related constants
- [ ] Remove handoff editor-mode settings that only existed for autocomplete
- [ ] Remove or rewrite autocomplete-specific tests and docs
- [ ] Remove `pi-sessions`-specific Powerline frontend integration work that existed only for autocomplete

### Phase 2 — build the picker

- [ ] Add `extensions/session-handoff/picker.ts`
- [ ] Add a small picker result contract:
  - [ ] `cancel`
  - [ ] `insert-session-token`
- [ ] Render the picker as an overlay through `ctx.ui.custom(..., { overlay: true })`
- [ ] Implement empty-query threaded browse mode
- [ ] Cap visual tree depth while preserving row order
- [ ] Implement query-driven flat search mode
- [ ] Wire `Enter` to return the selected `sessionId`
- [ ] Wire `Esc` to cancel
- [ ] Wire `Tab` to toggle scope if we keep two-scope mode

### Phase 3 — keep the current backend strategy and adapt it to picker rows

- [ ] Keep the existing indexed ranking/listing strategy
- [ ] Adapt `extensions/session-handoff/query.ts` for picker-row shaping
- [ ] Simplify picker-visible relation markers to `current`, `parent`, `child`, `sibling`, or short UUID prefix
- [ ] Extend the indexed row shape only if browse-mode threading needs additional parent/child metadata
- [ ] Keep the canonical insertion token unchanged: `@session:<uuid>`
- [ ] Add a shared `Intl`-based compact relative-time helper

### Phase 4 — connect the picker to the extension

- [ ] Register a dedicated shortcut such as `Alt+O`
- [ ] Allow overriding the picker shortcut from settings
- [ ] On selection, call `ctx.ui.pasteToEditor(`${SESSION_TOKEN_PREFIX}${sessionId}`)`
- [ ] Keep the `before_agent_start` system-prompt note for session tokens
- [ ] Wire the picker into `extensions/session-handoff.ts`

### Phase 5 — docs and regression coverage

- [ ] Update docs to describe the picker instead of autocomplete
- [ ] Add tests for:
  - [ ] threaded browse rendering over displayed rows
  - [ ] capped tree-depth rendering
  - [ ] flat search rendering for non-empty queries
  - [ ] simplified relation marker display
  - [ ] canonical token insertion: `@session:<uuid>`
  - [ ] cancel leaving the prompt untouched
  - [ ] missing-index state
- [ ] Add smoke steps covering:
  - [ ] start typing a prompt
  - [ ] open the picker with the shortcut
  - [ ] browse sessions
  - [ ] search for a known session
  - [ ] insert the token into the draft
  - [ ] cancel and confirm the draft is unchanged
