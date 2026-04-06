import type { EventBus } from "@mariozechner/pi-coding-agent";
import type {
  PowerlineAutocompleteInteractionHandle,
  PowerlineAutocompleteRegistration,
} from "pi-powerline-footer";
import {
  connectPowerlineAutocompleteExtension,
  createPowerlineAutocompleteInteractionHandle,
} from "pi-powerline-footer";

import {
  HandoffAutocompleteProvider,
  type HandoffAutocompleteRefreshData,
} from "./autocomplete.js";

const DEFAULT_PING_TIMEOUT_MS = 150;

export interface SessionHandoffPowerlineBindingOptions {
  extension: { id: string };
  indexPath: string;
  getCurrentSessionPath: () => string | undefined;
  getCurrentCwd: () => string | undefined;
  pingTimeoutMs?: number | undefined;
  attachTimeoutMs: number;
}

export interface SessionHandoffPowerlineBinding {
  disconnect(): void;
  interaction: PowerlineAutocompleteInteractionHandle<HandoffAutocompleteRefreshData>;
}

export async function connectPowerlineHandoffAutocomplete(
  events: EventBus,
  options: SessionHandoffPowerlineBindingOptions,
): Promise<SessionHandoffPowerlineBinding | null> {
  const timeoutMs = options.pingTimeoutMs ?? DEFAULT_PING_TIMEOUT_MS;
  const attachTimeoutMs = options.attachTimeoutMs;
  let interaction:
    | PowerlineAutocompleteInteractionHandle<HandoffAutocompleteRefreshData>
    | undefined;
  let resolveInitial: ((value: SessionHandoffPowerlineBinding | null) => void) | null = null;

  const initialResult = new Promise<SessionHandoffPowerlineBinding | null>((resolve) => {
    resolveInitial = resolve;
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
            indexPath: options.indexPath,
            getCurrentSessionPath: options.getCurrentSessionPath,
            getCurrentCwd: options.getCurrentCwd,
          });
        },
      },
    ],
    pingTimeoutMs: timeoutMs,
    onRegistered(registrations: PowerlineAutocompleteRegistration[]) {
      const firstRegistration = registrations[0];
      if (resolveInitial && firstRegistration) {
        interaction = createPowerlineAutocompleteInteractionHandle<HandoffAutocompleteRefreshData>(
          events,
          firstRegistration.installedId,
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
      }
    },
    onSyncError(_error) {
      // Powerline may emit its ready broadcast slightly later during session_start.
      // Keep listening so a later ready event can retry registration instead of
      // treating the first startup timeout as a permanent failure.
    },
  });

  const timeoutFallback = setTimeout(
    () => {
      if (resolveInitial) {
        resolveInitial(null);
        resolveInitial = null;
      }
    },
    Math.max(timeoutMs + 50, attachTimeoutMs),
  );

  const binding = await initialResult;
  clearTimeout(timeoutFallback);

  if (!binding) {
    dispose();
    interaction?.disconnect();
    return null;
  }

  return binding;
}
