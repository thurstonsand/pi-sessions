# 03 — Session handoff autocomplete Powerline integration

## 1. Goal

`pi-sessions` needs one session-handoff autocomplete implementation that can run in two explicitly selected modes:

1. **standalone**
   - `pi-sessions` owns the prompt editor
   - handoff autocomplete works without Powerline
2. **powerline**
   - `pi-powerline-footer` owns the editor
   - `pi-sessions` contributes `@session` autocomplete over the Powerline bridge

This design intentionally removes:

- auto mode
- settings-based Powerline detection
- silent fallback from failed Powerline integration into standalone ownership

The mode should be selected explicitly through settings.

## 2. Setting

Use a single nested setting:

```json
{
  "sessions": {
    "handoff": {
      "editor": "standalone"
    }
  }
}
```

Allowed values:

- `"standalone"` — default
- `"powerline"`

Semantics:

- `standalone`: `pi-sessions` installs its own editor integration
- `powerline`: `pi-sessions` attempts Powerline bridge registration and does **not** install its own editor fallback

This keeps the setting namespaced under handoff behavior.

## 3. Why explicit mode is the right fit

Pi exposes `pi.events` as the shared primitive for extension-to-extension coordination.
That surface supports event-based discovery and request/reply patterns, but it does not provide a built-in dependency or install-detection framework.

Because of that, the cleanest contract here is:

- explicit configuration decides which host should own the editor
- runtime bridge registration decides whether Powerline integration is actually available
- absence of a peer extension is handled by the chosen mode, not by guessing from settings

This avoids brittle heuristics such as checking package names or extension paths in settings.

## 4. Current seam

The real seam already exists between:

- `HandoffAutocompleteProvider` in `extensions/session-handoff/autocomplete.ts`
- the standalone-only `HandoffAutocompleteEditor` wrapper in the same file
- the Powerline adapter in `extensions/session-handoff/powerline.ts`

That means `pi-sessions` does **not** need two autocomplete implementations.
It needs one provider runtime and two host adapters.

## 5. Target behavior

### Standalone mode

When `sessions.handoff.editor = "standalone"`:

- install `HandoffAutocompleteEditor` via `ctx.ui.setEditorComponent(...)`
- render the hint widget below the editor directly
- keep `Alt+A` handling inside the standalone editor subclass
- never attempt Powerline registration

### Powerline mode

When `sessions.handoff.editor = "powerline"`:

- do **not** call `ctx.ui.setEditorComponent(...)`
- attempt `connectPowerlineHandoffAutocomplete(...)`
- if registration succeeds:
  - contribute the enhancer
  - install Powerline-mode input handling for `Alt+A`
  - drive refresh through the bridge interaction handle
- if registration fails:
  - show an error
  - leave handoff autocomplete disabled for that attach
  - do **not** fall back to standalone editor ownership

## 6. Files and responsibilities

### `extensions/session-handoff/autocomplete.ts`

Keeps package-owned autocomplete logic:

- detect `@session` prefixes
- query candidate sessions
- track whether handoff suggestions are active
- expose hint text
- expose refresh/update state used by either host mode

### `extensions/session-handoff.ts`

Owns mode selection once per session attach:

- read normalized settings
- dispose the previous install
- install standalone mode when configured
- install Powerline mode when configured
- emit a clear error when Powerline mode cannot attach

### `extensions/session-handoff/powerline.ts`

Owns Powerline-only integration:

- register the `@session` enhancer over the Powerline bridge
- create the interaction handle
- wire `Alt+A` terminal input while Powerline owns the editor
- request bridge refresh after scope toggles

### `extensions/shared/settings.ts`

Keeps package settings narrow and typed:

- read `sessions.handoff.editor`
- normalize to `"standalone" | "powerline"`
- default to `"standalone"`
- expose resolved package settings to extension entrypoints

No package sniffing. No extension-path detection. No Powerline inference.

## 7. Failure model

This design intentionally makes failure behavior simple and explicit.

### `standalone`

- always install standalone editor integration
- no dependency on Powerline

### `powerline`

- Powerline bridge present → integration works
- Powerline bridge absent or incompatible → show error and disable handoff autocomplete for that attach

That matches the setting contract: if the user explicitly chooses Powerline, failure should be loud.

## 8. Why no auto mode

Auto mode sounds convenient, but it forces `pi-sessions` to guess who should own the editor.
That guess then depends on settings sniffing, load-order assumptions, or weak probe heuristics.

This design rejects that complexity.

For now:

- explicit mode selection is simpler
- RPC handshake is the only runtime availability check
- settings only express user intent

If Pi later grows a better host/peer discovery model, `pi-sessions` can revisit this.

## 9. Tests

The important tests for this shape are:

- settings default to `standalone`
- global `sessions.handoff.editor` selection is respected
- standalone mode installs the editor component
- powerline mode registers through the bridge when available
- powerline mode failure shows an error and does not install standalone fallback

## 10. Summary

The key decision is to keep the host choice explicit.

`pi-sessions` should not try to infer whether Powerline is installed.
Instead:

- settings choose the desired host
- bridge registration confirms runtime availability
- failure behavior follows the explicit mode

That keeps the implementation small, deterministic, and easy to reason about.
