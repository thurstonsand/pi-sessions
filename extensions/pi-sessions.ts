import { type ExtensionAPI, SessionManager } from "@earendil-works/pi-coding-agent";
import { HostRegistry } from "./hosts/registry.ts";
import { installAsk } from "./session-ask/install.ts";
import { installAutoTitle } from "./session-auto-title/install.ts";
import { installHandoff } from "./session-handoff/install.ts";
import { installHooks } from "./session-hooks/install.ts";
import { installIndex } from "./session-index/install.ts";
import { createPeerDirectory, createSubagentDirectory } from "./session-messaging/directory.ts";
import { installMessaging } from "./session-messaging/install.ts";
import { MessageRouter } from "./session-messaging/message-router.ts";
import { installDirectoryTools } from "./session-messaging/pi/install.ts";
import { installSearch } from "./session-search/install.ts";
import type { SessionLifecycle } from "./shared/composition.ts";
import { type HerdrSession, resolveHerdrSession } from "./shared/herdr.ts";
import { getSessionModelRuntime } from "./shared/model-runtime.ts";
import { loadSettings, readCompactionSettings } from "./shared/settings.ts";
import { installSubagents, type SubagentsHandle } from "./subagents/install.ts";

/**
 * The single advertised entrypoint. It loads settings once, constructs each feature in
 * dependency order, and wires them by constructor parameters.
 * It also owns the single `session_start`/`session_shutdown` subscription so lifecycle order
 * is deterministic: broker registration (messaging) resolves before any other feature hook,
 * and incoming messages start turns only once every feature hook has resolved.
 */
export default function piSessions(pi: ExtensionAPI): void {
  const settings = loadSettings();
  let sessionEpoch = 0;
  const hosts = new HostRegistry();
  let herdr: HerdrSession | undefined;

  const index = installIndex(pi, { settings });
  const messaging = settings.features.messaging
    ? installMessaging(pi, { settings, index })
    : undefined;

  const lifecycles: SessionLifecycle[] = [];
  if (messaging) {
    lifecycles.push(messaging);
  }
  const messageRouter: MessageRouter | undefined = messaging
    ? new MessageRouter(
        messaging,
        () => subagents?.waker,
        () => sessionEpoch,
      )
    : undefined;
  const subagents: SubagentsHandle | undefined =
    settings.features.subagents && messaging && messageRouter
      ? installSubagents(pi, {
          settings,
          messaging,
          readCompactionSettings,
          sendMessage: (request) => messageRouter.sendMessage(request),
          getHerdr: () => herdr,
        })
      : undefined;
  if (subagents) {
    lifecycles.push(subagents);
  }
  const directoryTools = messaging
    ? installDirectoryTools(pi, {
        peers: createPeerDirectory(messaging, {
          indexPath: index.path,
          listSessions: () => messaging.listSessions(),
          getRelationTo: messaging.getCachedRelationTo,
          getParentSessionId: () => subagents?.getParentSessionId(),
        }),
        ...(subagents && messageRouter
          ? { subagents: createSubagentDirectory(subagents, messageRouter, messaging, index.path) }
          : {}),
        claimsPeers: () => hosts.claimsPeers(),
      })
    : undefined;
  if (settings.features.handoff) {
    const board = {
      showUserSessions: () => !hosts.claimsPeers(),
      roster: subagents?.roster,
      cancelSubagent: subagents
        ? (sessionId: string) => subagents.cancelSession(sessionId)
        : undefined,
      listLiveSessions: messaging ? () => messaging.listSessions() : undefined,
      readSessionEntries: (sessionFile: string) => SessionManager.open(sessionFile).getEntries(),
    };
    lifecycles.push(
      installHandoff(pi, {
        settings,
        index,
        getModelRuntime: getSessionModelRuntime,
        claimsPeers: () => hosts.claimsPeers(),
        getHerdr: () => herdr,
        ...(subagents ? { getLaunchTargets: () => subagents.getLaunchTargets() } : {}),
        board,
      }),
    );
  }
  const recallTools: { refresh(): void }[] = [];
  if (settings.features.search) {
    recallTools.push(
      installSearch(pi, { settings, index, claimsRecall: () => hosts.claimsRecall() }),
    );
  }
  if (settings.features.ask) {
    recallTools.push(
      installAsk(pi, {
        settings,
        index,
        claimsRecall: () => hosts.claimsRecall(),
        getModelRuntime: getSessionModelRuntime,
        ...(subagents
          ? { shouldMessageSubagent: (sessionId) => subagents.shouldMessageSubagent(sessionId) }
          : {}),
      }),
    );
  }
  if (settings.features.autoTitle) {
    lifecycles.push(
      installAutoTitle(pi, {
        settings,
        getModelRuntime: getSessionModelRuntime,
        getSessionEpoch: () => sessionEpoch,
      }),
    );
  }
  lifecycles.push(
    index,
    installHooks(pi, {
      index,
      turnSync: settings.features.hooks,
      getSessionEpoch: () => sessionEpoch,
    }),
  );
  // Messaging leads every session_start so the broker connection is registered before any
  // other feature hook runs. A side effect is that messaging's first relation snapshot can
  // predate hooks' index sync for this session; getCachedRelationTo self-heals on miss, so
  // this ordering is intentional — do not reorder to "fix" it.
  pi.on("session_start", async (event, ctx) => {
    sessionEpoch += 1;
    hosts.discover(pi.events);
    for (const tool of recallTools) tool.refresh();
    // One answer per session start, so split handoffs and subagent workers agree on a backend.
    herdr = await resolveHerdrSession();
    for (const lifecycle of lifecycles) {
      await lifecycle.onSessionStart?.(event, ctx);
    }
    directoryTools?.refresh();
    for (const lifecycle of lifecycles) {
      lifecycle.onSessionReady?.(ctx);
    }
  });

  pi.on("session_shutdown", async (event, ctx) => {
    sessionEpoch += 1;
    for (let index = lifecycles.length - 1; index >= 0; index -= 1) {
      await lifecycles[index]?.onSessionShutdown?.(event, ctx);
    }
  });
}
