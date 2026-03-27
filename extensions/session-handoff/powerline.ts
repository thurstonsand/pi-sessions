import type { EventBus } from "@mariozechner/pi-coding-agent";
import type { PowerlineAutocompleteInteractionHandle } from "pi-powerline-footer";
import {
  connectPowerlineAutocompleteExtension,
  createPowerlineAutocompleteInteractionHandle,
} from "pi-powerline-footer";

import {
  HandoffAutocompleteProvider,
  type HandoffAutocompleteRefreshData,
} from "./autocomplete.js";

export interface SessionHandoffPowerlineBindingOptions {
  extension: { id: string };
  getCurrentSessionPath: () => string | undefined;
  getCurrentCwd: () => string | undefined;
  pingTimeoutMs?: number | undefined;
}

export interface SessionHandoffPowerlineBinding {
  disconnect(): void;
  interaction: PowerlineAutocompleteInteractionHandle<HandoffAutocompleteRefreshData>;
}

export async function connectPowerlineHandoffAutocomplete(
  events: EventBus,
  options: SessionHandoffPowerlineBindingOptions,
): Promise<SessionHandoffPowerlineBinding | null> {
  const timeoutMs = options.pingTimeoutMs ?? 150;
  let interaction:
    | PowerlineAutocompleteInteractionHandle<HandoffAutocompleteRefreshData>
    | undefined;
  let resolveInitial: ((value: SessionHandoffPowerlineBinding | null) => void) | null = null;
  let rejectInitial: ((reason?: unknown) => void) | null = null;

  const initialResult = new Promise<SessionHandoffPowerlineBinding | null>((resolve, reject) => {
    resolveInitial = resolve;
    rejectInitial = reject;
  });

  const dispose = connectPowerlineAutocompleteExtension(events, {
    extension: options.extension,
    enhancers: [
      {
        id: "session-handoff",
        trigger: { prefixes: ["@session", "@session:"] },
        enhance(baseProvider) {
          return new HandoffAutocompleteProvider({
            baseProvider,
            getCurrentSessionPath: options.getCurrentSessionPath,
            getCurrentCwd: options.getCurrentCwd,
          });
        },
      },
    ],
    pingTimeoutMs: timeoutMs,
    onRegistered(installedIds) {
      const firstId = installedIds[0];
      if (resolveInitial && firstId) {
        interaction = createPowerlineAutocompleteInteractionHandle<HandoffAutocompleteRefreshData>(
          events,
          firstId,
        );
        const binding: SessionHandoffPowerlineBinding = {
          disconnect() {
            interaction?.disconnect();
            dispose();
          },
          interaction,
        };
        resolveInitial(binding);
        resolveInitial = null;
        rejectInitial = null;
      }
    },
    onSyncError(error) {
      if (rejectInitial) {
        rejectInitial(error);
        resolveInitial = null;
        rejectInitial = null;
      }
    },
  });

  // If the initial ping times out, connectPowerlineAutocompleteExtension calls onSyncError
  // with a timeout error. Give it time to settle before declaring absence.
  const timeoutFallback = setTimeout(() => {
    if (resolveInitial) {
      resolveInitial(null);
      resolveInitial = null;
      rejectInitial = null;
    }
  }, timeoutMs + 50);

  const binding = await initialResult;
  clearTimeout(timeoutFallback);

  if (!binding) {
    dispose();
    interaction?.disconnect();
    return null;
  }

  return binding;
}
