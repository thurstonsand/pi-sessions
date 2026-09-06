# Fullscreen mouse input

## Status

Accepted, implemented.

## Decision

The session reference picker, Handoffs board, title wizard, handoff preview, session index panel, and their loader hints handle Pi's normalized fullscreen pointer events. Keyboard navigation and action bindings keep their existing behavior. Mouse motion never changes selection.

The picker stays custom. It already uses Pi's `Input`, but Pi 0.85's `SelectList` cannot reproduce its second-line search snippets, aligned metadata, clamped arrow navigation, or Page Up/Down behavior without replacing those parts again. Thurston explicitly chose to preserve the current navigation rather than simplify it for native list adoption.

## Interaction rules

- A list press selects; its click commits where the list has a commit action. Board rows only select and reveal details. Stopping a subagent remains a separate action followed by confirmation.
- The wheel moves the picker or board selection one item per event. The wizard moves its scope selection; the preview scrolls its prompt.
- Action hints run what they advertise and highlight their text while held. Release clears the highlight before click commits; dragging away clears both feedback and the pending action. Direction hints such as `↑↓ select` and `j/k: scroll` remain inert. Tab labels and the picker's scope labels use the same press feedback.
- Text presses and drags stay unhandled so Pi can select text for the clipboard. The filter handles cursor placement on click. Pi's `Input` currently implements cursor placement on press, so the picker forwards that click as a child-local press only after the renderer has ruled out a drag.
- Clicking the preview's action hints or scrolling it disables autostart before release can race the countdown.
- The handoff loader's cancel hint is worth supporting: it aborts the same task signal as Escape. The reindex loader's hint dismisses the loader, just as its existing keyboard cancellation does; it does not interrupt the underlying rebuild.

## A gesture retains its target

Pi's fullscreen renderer retains the receiving component's origin from the press and reuses it when delivering release and synthesized click. Selection can scroll a list, change details, or move a bottom-anchored component. The same local row can then name a different control.

Each component records the pressed session or action and consumes that record on click. Every new press replaces it, including non-primary and inert presses. Release alone does not clear it because Pi delivers click after release. Dragging away produces no click; the next press discards the abandoned target.

The picker retains session IDs rather than array indexes, including the selected session behind its add-to-prompt hint. A pending search debounce can replace the entire result list between press and click, and the session the user pressed still wins. Keyboard Enter keeps its existing behavior of flushing a pending search before confirming. Board actions also retain the selected session and confirmation state; a refresh, changed selection, or changed available command cannot turn an old gesture into a new operation. Wizard controls retain the exact step object, so an Enter gesture from the mode chooser cannot confirm a later bulk-retitle warning.

## Rendering and bounds

Components record hit ranges while rendering and clear their maps at the start of each render. Borders, padding outside a control, hint separators, and unrelated text have no action. Multiline picker snippets belong to their session but do not make their trailing padding clickable. A fully or partially clipped legend hint has no hit range.

`extensions/shared/legend.ts` lays out hint text and hit ranges together. Its shared `LegendPointer` separates the held highlight from the captured action, so rendering after release cannot lose the subsequent click. Hints identify themselves by their key and description; holding `x stop` must not highlight `x confirm` just because it reuses the key. Gaps and clipped hints never highlight. The picker, board, preview, index panel, and loader hints share both helpers. The wizard uses the same pointer with its existing individually styled full-line choices, and gates feedback by the exact step object as well as the key.

The board's snapshot-loading code lives in `board-loading.ts`, separate from rendering and input. The index panel and loader live in sibling implementation modules rather than growing `install.ts`.

## Verification

Mouse regressions exercise actual reflow rather than merely clicking static rows:

- Selecting Current session in a four-result picker window moves Parent session into its former row. Removing captured identity inserts Parent instead. A separate debounce regression inserts Sibling instead of the pressed Parent when identity is removed.
- The board's eight-row viewport, changing detail heights, and refreshed row order exercise selection and action identity. Replacing the captured target with a fresh coordinate lookup fails eight tests.
- Wrapping the wizard's current title moves the folder choice's former row onto the current-session choice. A stale Enter gesture across the bulk-warning transition separately verifies the step guard.
- Resizing the preview can remove its cancel hint between press and click. The captured cancel action still runs once. Narrowing the reindex loader wraps its message and moves its cancel hint; release still cancels.

The identity and abandoned-press regressions were run with their respective fixes deliberately removed and failed before restoration. Press-feedback tests separately fail when release leaves the highlight on, release discards the callback, drag preserves the action, or clipping still paints a held hint. The picker also has an integration test that sends raw SGR press/drag/release sequences through a real `TuiAltScreen` and a bottom-anchored overlay, including renderer-level text selection. `SMOKE.md` documents the command that prints its before/after rows.

## Compatibility

Pointer routing requires Pi 0.85.0 or newer with `"tuiMode": "fullscreen"`. Regular mode keeps terminal-owned scrollback and the existing keyboard paths. No terminal mouse escape parsing lives in pi-sessions.
