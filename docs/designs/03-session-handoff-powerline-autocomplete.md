# 03 — Session handoff autocomplete Powerline migration plan

## Context

`02-session-handoff-capability.md` added `@session:<uuid>` autocomplete by having `pi-sessions` own the prompt editor directly.

That implementation works today, but it is now the main interoperability problem with `pi-powerline-footer`:

- `pi-sessions` currently calls `ctx.ui.setEditorComponent(...)` from `extensions/session-handoff.ts`
- Powerline also calls `ctx.ui.setEditorComponent(...)`
- Pi only has one editor slot, so the last package to install wins
- Powerline now exposes a host-owned autocomplete bridge and provider-owned hint surface

The goal of this design is to migrate `pi-sessions` onto that bridge when Powerline is available or explicitly selected as the host, while preserving the current standalone editor behavior when Powerline is absent or when `pi-sessions` is explicitly configured to own the editor itself.

This plan should be read together with:

- `docs/designs/01-session-search-capability.md`
- `docs/designs/02-session-handoff-capability.md`
- sibling reference: `../pi-powerline-footer/docs/designs/02-editor-autocomplete-hook.md`
  - we should also inspect the implementation itself, not just the design doc, so we understand the real integration surface
- `../pi-powerline-footer/.tmp-live-smoke/autocomplete-hint-smoke.ts`
  - useful prior art for provider-owned hints plus external `Alt+A` handling while Powerline still owns the editor

## Problem Statement

`pi-sessions` needs one autocomplete implementation that can run in two modes:

1. **Standalone mode**
   - `pi-sessions` owns the editor
   - current behavior stays intact, including `Alt+A` scope toggling and the below-editor hint
2. **Powerline mode**
   - Powerline owns the editor
   - `pi-sessions` contributes `@session` behavior through the Powerline autocomplete bridge instead of replacing the editor
   - `pi-sessions` should still preserve `Alt+A` scope toggling in v1 if the Powerline-hosted path can support it cleanly

The migration should keep the seam as small as possible.

## Existing Behavior

### Current seam in `extensions/session-handoff/autocomplete.ts`

The current file already has a natural split:

- `HandoffAutocompleteProvider` (`extensions/session-handoff/autocomplete.ts:84-248`)
  - detects `@session` prefixes
  - queries indexed candidates
  - applies canonical completions
  - preserves file-completion hooks from the wrapped base provider
  - owns autocomplete-local state (`includeAllSessions`, active mode, scope label)
- `HandoffAutocompleteEditor` (`extensions/session-handoff/autocomplete.ts:250-325`)
  - subclasses `CustomEditor`
  - wraps the base provider in `setAutocompleteProvider(...)`
  - intercepts `Alt+A`
  - refreshes autocomplete
  - pushes a hint widget through `setAutocompleteStatus(...)`

That means the smallest real seam is **not** inside query/prefix logic. The seam is already between the provider and the editor subclass.

### Current registration in `extensions/session-handoff.ts`

`installHandoffEditor(...)` (`extensions/session-handoff.ts:194-218`) unconditionally:

- clears a local widget key
- installs `HandoffAutocompleteEditor`
- renders the hint below the editor itself

That unconditional editor ownership is what must change.

### Powerline’s current bridge surface

Powerline now exposes:

- trigger-aware provider wrapping
- a load-order-safe bridge over `pi.events`
- provider-owned hint rendering through `getPowerlineAutocompleteHint()`

Relevant sibling files:

- `../pi-powerline-footer/autocomplete-runtime.ts`
- `../pi-powerline-footer/autocomplete-bridge.ts`
- `../pi-powerline-footer/index.ts`
- `../pi-powerline-footer/.tmp-live-smoke/autocomplete-hint-smoke.ts`

Important constraints from the current Powerline implementation:

- Powerline can host wrapped providers and show their hints
- the bridge itself does not currently expose a dedicated consumer keybinding hook
- prior work does **not** reserve `Alt+A` for Powerline; `pi-sessions` can own that behavior if it wires input handling outside editor ownership
- the live smoke example strongly suggests that Powerline-hosted autocomplete plus `pi-sessions`-owned `Alt+A` is plausible and should be explored as part of this migration, not deferred
- we also control `pi-powerline-footer`, so if the cleanest integration needs a small Powerline-side API or behavior change, that is in scope for this design rather than an external blocker

## Design Decisions

### 1. `HandoffAutocompleteProvider` becomes the shared runtime seam

The cleanest boundary is to keep `HandoffAutocompleteProvider` as the package-owned runtime and make editor ownership a thin adapter around it.

We should **not** split candidate lookup, token parsing, or completion application into a second abstraction. That logic already composes correctly through the provider, and this migration does not introduce a new requirement that would justify another layer.

Concretely:

- keep `detectHandoffPrefix(...)`
- keep `HandoffAutocompleteProvider` as the session-specific runtime
- keep query logic in `extensions/session-handoff/query.ts`
- move editor-specific concerns out of the provider consumer path

The provider should be treated as the canonical owner of:

- whether handoff suggestions are active
- whether the current scope is default vs all
- what hint text should be shown
- how session completions replace typed text

### 2. Hint text should move fully into the provider runtime

Right now the standalone editor computes hint text itself and pushes it through `setAutocompleteStatus(...)`.

That should move into the provider so both modes use the same source of truth.

Recommended change:

- add `getPowerlineAutocompleteHint?(): string | undefined` to `HandoffAutocompleteProvider`
- have it return:
  - `undefined` when handoff autocomplete is not active
  - `undefined` when scope toggling is unavailable for the current host
  - `"Alt+A: show all sessions"` or `"Alt+A: show current repo sessions"` when active and toggle support is available

This lets:

- standalone mode read the same provider hint and keep rendering its own widget
- Powerline mode reuse the exact same provider hint through the bridge

The `.tmp-live-smoke/autocomplete-hint-smoke.ts` example is good prior art here: the hint remains a plain provider capability, while the toggle itself can be driven externally.

### 3. Scope toggling should remain capability-driven, but v1 should target parity in both modes

Today `canToggleIncludeAllSessions()` always returns `true`.

That should become an explicit runtime capability passed into the provider.

Recommended option:

```ts
interface HandoffAutocompleteProviderOptions {
  baseProvider: AutocompleteProvider;
  getCurrentSessionPath: () => string | undefined;
  getCurrentCwd: () => string | undefined;
  allowScopeToggle?: boolean;
  limit?: number;
}
```

Behavior:

- **standalone mode** sets `allowScopeToggle: true`
- **Powerline mode** should also set `allowScopeToggle: true` in v1 if `pi-sessions` successfully installs its own `Alt+A` terminal-input handler alongside the bridge registration
- only hosts that truly cannot wire the toggle should set `allowScopeToggle: false`

The important change is that hint visibility and toggle availability come from real runtime capability, not from an assumption about who owns the editor.

### 4. Keep two thin adapters, not two implementations

Because we control both packages, this adapter boundary does **not** mean `pi-sessions` must contort itself around every current Powerline limitation. If a very small Powerline-side addition would make the integration cleaner or more deterministic, we should prefer that over adding awkward `pi-sessions`-local workarounds.

Design principle: **prefer small Powerline-side API changes over `pi-sessions` workarounds when we control both packages.**

The shared runtime should feed two adapters:

#### Standalone adapter

This is the current editor-owned path, preserved with minimal change:

- `HandoffAutocompleteEditor` continues to subclass `CustomEditor`
- it wraps the base provider with `HandoffAutocompleteProvider`
- it intercepts `Alt+A`
- it refreshes autocomplete after toggling
- it renders the hint widget from `provider.getPowerlineAutocompleteHint()`

#### Powerline adapter

Add a new bridge-facing adapter that contributes a Powerline enhancer plus host-specific input wiring instead of an editor subclass.

Conceptually:

```ts
createPowerlineHandoffAutocompleteConnection(options)
```

That connection should:

- register a Powerline enhancer that triggers on `@session` and `@session:`
- wrap the base provider with `HandoffAutocompleteProvider`
- expose `getPowerlineAutocompleteHint()` from the wrapped provider
- install an `Alt+A` terminal-input handler owned by `pi-sessions`
- consume `Alt+A` only while `@session` autocomplete is relevant/visible
- refresh or re-activate autocomplete after toggling so the candidate list and hint text update immediately
  - first try the same pattern proven out in the Powerline smoke example
  - if needed, add a tiny Powerline-side refresh/action hook rather than accepting stale state in v1

This keeps one autocomplete implementation and only swaps the hosting layer.

### 5. `extensions/session-handoff.ts` should own host selection once per attach

Replace unconditional `installHandoffEditor(...)` with a small coordinator that chooses **Powerline** or **standalone** mode.

Recommended entry point shape:

```ts
installHandoffAutocomplete(ctx, pi.events)
```

Responsibilities:

- dispose any prior bridge/input connection for the current extension instance
- clear the standalone widget key before re-attaching
- read host configuration from Pi settings at `sessions.handoff.editor.host`
- support:
  - `"auto"` — default
  - `"standalone"`
  - `"powerline"`
- if host is `"standalone"`, install the standalone editor path immediately
- if host is `"powerline"`, require successful bridge registration and do **not** call `setEditorComponent(...)`
- if host is `"auto"`, use Pi config as the first signal before doing any live probing:
  - read merged Pi settings directly and inspect the top-level resource-loading paths that actually determine whether Powerline should load:
    - `packages[]` — primary signal; look for a package source matching `pi-powerline-footer`
    - `extensions[]` — secondary signal for explicit local extension-path installs of Powerline
  - the nested `powerline` config object can be treated as a supplementary hint, but not as the authoritative enabled/installed signal by itself
  - if Pi config does **not** indicate Powerline is configured/enabled, install the standalone editor path immediately
  - if Pi config suggests Powerline should be active, prefer the Powerline path and then confirm live availability via bridge probe
  - if live probe confirms Powerline, register the enhancer path and do **not** call `setEditorComponent(...)`
  - if Powerline appears expected/present but returns an incompatible/error state, fail loudly instead of silently switching ownership modes
  - only treat Powerline as absent in auto mode when both config and live probe say so

This keeps the default ergonomic while preserving determinism: absence of Powerline is a valid auto-mode fallback, but explicit Powerline mode or incompatible bridge states should not silently degrade into standalone editor ownership. It also avoids making startup UX depend on a long blind ping timeout when config already tells us which host is likely intended.

### 6. Powerline integration should use the event bridge directly, not package imports

`pi-sessions` should not depend on importing `pi-powerline-footer` at runtime.

Reason:

- this extension has its own `package.json`
- it cannot assume visibility into another package's runtime dependency graph
- normal imports and guarded dynamic imports are therefore the wrong abstraction here

Instead:

1. add a dedicated Powerline adapter module, for example:
   - `extensions/session-handoff/powerline.ts`
2. implement the Powerline protocol over `pi.events` directly in that module
3. probe host availability with the same load-order-safe handshake Powerline already uses, but let config drive the decision first:
   - read merged Pi settings directly to determine whether Powerline is configured/enabled
   - check top-level `packages[]` first for `pi-powerline-footer`
   - also check top-level `extensions[]` for explicit local extension-path installs
   - do not treat nested `powerline` settings alone as proof that the extension is actually loaded
   - if config does not indicate Powerline, skip the startup wait and treat auto mode as standalone immediately
   - if config suggests Powerline should be active, subscribe to `powerline:autocomplete:ready` and emit `powerline:autocomplete:rpc:ping` with a request id
   - if a valid ping reply arrives within a short timeout, treat Powerline as available
   - if `ready` arrives first, immediately re-run the ping/register attempt rather than waiting for the original timeout
   - keep the timeout short; this is a bounded readiness confirmation, not a 1s+ UX stall
   - if ping times out and no `ready` arrives during the probe window despite config suggesting Powerline, treat that according to host mode rather than silently waiting forever
   - if ping/reply succeeds but protocol version is wrong, or if register returns an invalid/error reply, treat that as a real integration error
4. interpret probe outcomes according to `sessions.handoff.editor.host`:
   - `auto`: config says no Powerline -> install standalone
   - `auto`: config suggests Powerline, but live probe never finds it -> install standalone only if we decide that specific case is truly equivalent to absence; otherwise raise an error
   - `powerline`: no host present -> raise an error
   - any mode: protocol mismatch / invalid register reply / partial registration failure -> raise an error rather than silently changing ownership strategy

This keeps all Powerline-specific logic isolated to one file while avoiding package-resolution ambiguity.

Because we control `pi-powerline-footer`, it is also acceptable to make a small companion change there if it improves this path, for example:

- exporting a more explicit ready/protocol constant set from a genuinely shared location later
- adding a tiny helper for editor refresh after external toggle actions
- adding a narrow consumer action hook if terminal-input interception proves too indirect

The constraint is only that `pi-sessions` should integrate through a stable bridge contract, not through ad hoc runtime imports.

### 7. Do not attempt mid-session live handover in v1

If standalone mode is already installed for the current editor instance, and Powerline becomes available later in the same session, `pi-sessions` should **not** attempt a live ownership handoff.

Reason:

- both packages use the same `setEditorComponent(...)` slot
- unsetting or re-setting that slot mid-session is easy to get wrong
- a mistaken cleanup call could restore the default editor and clobber Powerline

So the coordinator should make a mode choice when attaching on:

- `session_start`
- `session_switch`
- `session_fork`
- `/reload`

That is the smallest reliable migration.

### 8. Powerline mode in v1 should aim for full handoff-autocomplete parity

The first migration slice should preserve:

- `@session` suggestions
- canonical completion insertion
- file-completion interoperability
- dynamic below-editor hints through Powerline
- `Alt+A` scope toggling, owned by `pi-sessions` even while Powerline owns the editor

The current best lead for that last item is the Powerline smoke example: external terminal input handling plus provider-owned dynamic hint text.

Because we control Powerline too, failure of that exact approach would not automatically mean cutting scope. It would mean we should make the smallest Powerline-side change needed to preserve parity.

If the smoke-pattern approach turns out not to be robust enough, we should document the exact blocker and then implement the minimal Powerline-side support needed rather than accepting intentional degradation by default.

## Edge Cases

- **`sessions.handoff.editor.host = "standalone"`**
  - install standalone editor
  - ignore Powerline bridge entirely
- **`sessions.handoff.editor.host = "auto"` and Pi config does not indicate Powerline**
  - install standalone editor immediately
  - this is an expected fallback, not an error
- **`sessions.handoff.editor.host = "auto"`, Pi config suggests Powerline, but live probe does not find it promptly**
  - treat this as a special startup/readiness case
  - keep the probe window short
  - prefer an explicit policy here rather than a long implicit timeout stall
- **`sessions.handoff.editor.host = "powerline"` and bridge is unavailable**
  - raise an error
  - notify the user
  - do **not** install the standalone editor as a fallback
- **Auto mode detects Powerline, but protocol version mismatches or registration fails**
  - raise an error
  - do **not** silently switch to standalone, because Powerline is present but integration is in a bad state
- **Repeated attach events**
  - previous bridge/input connection must be disposed before re-registering
  - standalone widget key must be cleared before each re-attach
- **Autocomplete closes**
  - provider state should reset exactly once, same as today
  - hint should disappear in both standalone and Powerline modes
  - `Alt+A` handling should only consume input while `@session` autocomplete is relevant/visible
- **No session index / wrong schema**
  - autocomplete already returns no candidates; migration should preserve that behavior
- **Late Powerline availability after standalone attach**
  - no live swap in v1; re-evaluate on next attach or reload
- **Powerline mode without successful toggle wiring**
  - treat this as an integration bug to fix during implementation validation, not as a planned degraded mode

## Rejected Alternatives

### Keep unconditional editor ownership and ignore Powerline

Rejected because it preserves the current incompatibility.

### Rewrite autocomplete into a brand-new generic controller before migrating

Rejected because it is more change than the problem requires.

The provider already owns the real runtime state. We should formalize that seam instead of rebuilding the feature.

### Best-effort import-based Powerline detection

Rejected because `pi-sessions` should not assume it can import `pi-powerline-footer` directly from its own package boundary.

The integration contract should be the event bridge, not Node module resolution.

### Silent fallback from failed Powerline registration to standalone editor ownership

Rejected except for the specific `sessions.handoff.editor.host = "auto"` case where Powerline is simply absent.

If Powerline is explicitly configured, or if auto mode detects Powerline but encounters an incompatible/error state, bridge failure should be loud rather than silently switching editor ownership.

### Drop standalone mode and require Powerline

Rejected because `pi-sessions` should keep working as an independent package when explicitly configured to own the editor.

## Integration Points

### `extensions/session-handoff/autocomplete.ts`

Primary changes:

- keep `HandoffAutocompleteProvider` as shared runtime
- add capability-driven toggle support
- add provider-owned hint generation
- keep `HandoffAutocompleteEditor` as the standalone adapter
- change the standalone adapter to read hint text from the provider instead of formatting it independently

### `extensions/session-handoff.ts`

Replace unconditional `installHandoffEditor(...)` with a coordinator that chooses:

- standalone editor install, or
- Powerline bridge registration plus `Alt+A` input wiring

This file should also own:

- host selection from `sessions.handoff.editor.host`
- reading normalized Pi settings directly
- auto-detect fallback behavior
- loud failure behavior for explicit/incompatible Powerline states
- cleanup across repeated session attach events

### New `extensions/session-handoff/powerline.ts`

Suggested responsibilities:

- event-bridge protocol constants/helpers local to this package
- bridge ready/ping/register/unregister handling
- one-shot availability probing for auto mode
- enhancer creation/registration
- `Alt+A` terminal-input handling while Powerline owns the editor
- cleanup / disconnect handling

This keeps all Powerline-specific logic out of the provider and editor runtime.

### New `settings.ts` (or equivalent)

Suggested responsibilities:

- read Pi settings directly from the same underlying config source/style Powerline uses
- normalize nested `sessions.handoff.editor.host`
- expose a helper for detecting whether Pi config indicates Powerline is configured/enabled
  - primary check: merged top-level `packages[]` contains `pi-powerline-footer`
  - secondary check: merged top-level `extensions[]` contains an explicit Powerline extension path
  - nested `powerline` config is only a weak supplementary hint
- default to `auto` when unset/invalid
- keep any future `pi-sessions` config under the nested `sessions` object rather than inventing a separate config path

### Tests

Update or add coverage for:

- standalone provider wrapping still works
- standalone `Alt+A` toggle still works
- provider-owned hint generation
- bridge enhancer creation uses the same provider runtime
- Powerline-mode `Alt+A` toggling works through external input handling
- `Alt+A` is only consumed while `@session` autocomplete is relevant/visible
- settings normalization for nested `sessions.handoff.editor.host`
- mode coordinator honors `sessions.handoff.editor.host`
- auto mode falls back to standalone only when Powerline is absent
- auto mode treats protocol mismatch / bad register replies as errors, not fallback
- explicit/incompatible Powerline states fail loudly instead of falling back silently
- cleanup on repeated attach events

## Implementation Plan

### Phase 1 — formalize the shared runtime seam

- [ ] Update `extensions/session-handoff/autocomplete.ts`
- [ ] Add a provider option for toggle capability (`allowScopeToggle` or equivalent)
- [ ] Move hint generation into `HandoffAutocompleteProvider`
- [ ] Keep `HandoffAutocompleteEditor` as a standalone adapter around that provider
- [ ] Update standalone hint rendering to read from the provider instead of duplicating string logic
- [ ] Add tests for provider-owned hint text and capability-gated toggling

### Phase 2 — prototype the Powerline-hosted parity path

- [ ] Inspect `../pi-powerline-footer/.tmp-live-smoke/autocomplete-hint-smoke.ts` and related Powerline runtime code
- [ ] Prove out `Alt+A` handling under Powerline ownership using `pi-sessions`-owned terminal input plus provider-owned hint text
- [ ] Confirm how autocomplete refresh should be triggered after toggling in the Powerline-hosted path
- [ ] If the smoke-pattern approach is insufficient, make the smallest Powerline-side change needed to preserve parity
- [ ] Write down any blocker immediately if parity still turns out not to be robust

### Phase 3 — add a Powerline-specific bridge adapter

- [ ] Add `extensions/session-handoff/powerline.ts`
- [ ] Implement the Powerline bridge protocol directly over `pi.events`
- [ ] Implement one-shot bridge probing for auto mode via `ready` + `ping`
- [ ] Register a Powerline enhancer that wraps the base provider with `HandoffAutocompleteProvider`
- [ ] Expose provider hint text to Powerline through `getPowerlineAutocompleteHint()`
- [ ] Install and clean up `Alt+A` input handling while Powerline owns the editor
- [ ] Add tests for bridge probing, registration, and cleanup on repeated attach events

### Phase 4 — replace unconditional editor install with a host coordinator

- [ ] Add a `settings.ts` helper modeled after Powerline's nested settings handling
- [ ] Normalize `sessions.handoff.editor.host` with values `auto` (default), `standalone`, and `powerline`
- [ ] Update `extensions/session-handoff.ts`
- [ ] Replace `installHandoffEditor(...)` with `installHandoffAutocomplete(...)`
- [ ] In `auto`, probe Powerline first and fall back to standalone only when Powerline is absent
- [ ] In `powerline`, fail loudly if bridge registration is unavailable
- [ ] In any mode, treat protocol mismatch / invalid registration replies as errors rather than silent fallback
- [ ] On attach, clear stale standalone widget state before re-installing
- [ ] Register the bridge path when host resolution selects Powerline
- [ ] Install the standalone editor path only when host resolution selects standalone
- [ ] Preserve current behavior on `session_start`, `session_switch`, and `session_fork`
- [ ] Do not attempt mid-session live handover in this phase

### Phase 5 — package/runtime validation

- [ ] Run `npm test`
- [ ] Run `npm run typecheck`
- [ ] Run `npm run lint`
- [ ] Smoke-test `pi-sessions` alone and confirm current standalone behavior is unchanged
- [ ] Smoke-test `pi-sessions` + Powerline together and confirm `@session` suggestions, `Alt+A` toggling, and live hints render correctly under Powerline ownership
- [ ] Verify Powerline-host misconfiguration fails loudly and does not race into standalone editor ownership

## Notes

The key migration insight is that `pi-sessions` does **not** need a second autocomplete implementation.

It already has the right runtime object. The migration is mostly about:

- promoting the provider to the official seam
- shrinking the editor subclass into a standalone-only adapter
- adding one isolated Powerline adapter that hosts the same provider through the bridge
- proving that Powerline-hosted mode can still preserve the existing toggle UX by letting `pi-sessions` own the toggle behavior directly
