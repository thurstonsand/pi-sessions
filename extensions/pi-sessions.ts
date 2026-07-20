import type { ExtensionAPI, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { installAsk } from "./session-ask/install.ts";
import { installAutoTitle } from "./session-auto-title/install.ts";
import { installHandoff } from "./session-handoff/install.ts";
import { installHooks } from "./session-hooks/install.ts";
import { installIndex } from "./session-index/install.ts";
import { installMessaging } from "./session-messaging/install.ts";
import {
  createSessionCancelTool,
  createSessionSendMessageTool,
} from "./session-messaging/pi/tools.ts";
import { installSearch } from "./session-search/install.ts";
import type { SessionLifecycle } from "./shared/composition.ts";
import { createSessionModelRuntime, type ModelRuntimeProvider } from "./shared/model-runtime.ts";
import { loadSettings } from "./shared/settings.ts";
import { installSubagents } from "./subagents/install.ts";

/**
 * The single advertised entrypoint. It loads settings once, constructs each feature in
 * dependency order, and wires them by constructor parameters.
 * It also owns the single `session_start`/`session_shutdown` subscription so lifecycle order
 * is deterministic: broker registration (messaging) resolves before any other feature hook.
 */
export default function piSessions(pi: ExtensionAPI): void {
  const settings = loadSettings();
  let sessionEpoch = 0;

  // The mirrored ModelRuntime is expensive to build and only changes across session
  // boundaries, so cache it per epoch (the root's own invalidation signal) instead of
  // rebuilding it on every auto-title, /title, session_ask, and handoff draft.
  let cachedModelRuntime: { epoch: number; runtime: Promise<ModelRuntime> } | undefined;
  const getModelRuntime: ModelRuntimeProvider = (modelRegistry) => {
    if (cachedModelRuntime?.epoch !== sessionEpoch) {
      cachedModelRuntime = {
        epoch: sessionEpoch,
        runtime: createSessionModelRuntime(modelRegistry),
      };
    }
    return cachedModelRuntime.runtime;
  };

  const index = installIndex(pi, { settings });
  const messaging = settings.features.messaging
    ? installMessaging(pi, { settings, index })
    : undefined;

  const lifecycles: SessionLifecycle[] = [];
  if (messaging) {
    lifecycles.push(messaging);
  }
  const subagents =
    settings.features.subagents && messaging
      ? installSubagents(pi, { settings, messaging })
      : undefined;
  if (subagents) {
    lifecycles.push(subagents);
  }
  if (messaging) {
    pi.registerTool(
      createSessionSendMessageTool(subagents ?? messaging, {
        wakeCapable: Boolean(subagents),
        getCachedRelationTo: messaging.getCachedRelationTo,
      }),
    );
    pi.registerTool(createSessionCancelTool(subagents ?? messaging));
  }
  if (settings.features.handoff) {
    lifecycles.push(
      installHandoff(pi, {
        settings,
        index,
        getModelRuntime,
        ...(subagents ? { getLaunchTargets: () => subagents.getLaunchTargets() } : {}),
      }),
    );
  }
  if (settings.features.search) {
    installSearch(pi, { settings, index, messaging });
  }
  if (settings.features.ask) {
    installAsk(pi, { settings, index, getModelRuntime });
  }
  if (settings.features.autoTitle) {
    lifecycles.push(
      installAutoTitle(pi, {
        settings,
        getModelRuntime,
        getSessionEpoch: () => sessionEpoch,
      }),
    );
  }
  if (settings.features.hooks) {
    lifecycles.push(installHooks(pi, { settings, index }));
  }

  // Messaging leads every session_start so the broker connection is registered before any
  // other feature hook runs. A side effect is that messaging's first relation snapshot can
  // predate hooks' index sync for this session; getCachedRelationTo self-heals on miss, so
  // this ordering is intentional — do not reorder to "fix" it.
  pi.on("session_start", async (event, ctx) => {
    sessionEpoch += 1;
    for (const lifecycle of lifecycles) {
      await lifecycle.onSessionStart?.(event, ctx);
    }
  });

  pi.on("session_shutdown", async (event, ctx) => {
    sessionEpoch += 1;
    for (const lifecycle of lifecycles) {
      await lifecycle.onSessionShutdown?.(event, ctx);
    }
  });
}
