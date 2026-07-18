import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { IndexHandle, SessionLifecycle } from "../shared/composition.ts";
import type { SessionSettings } from "../shared/settings.ts";
import {
  IncomingSessionMessageRuntime,
  SESSION_MESSAGE_CUSTOM_TYPE,
} from "./pi/incoming-runtime.ts";
import { renderIncomingSessionMessage } from "./pi/renderer.ts";
import { SessionMessagingService } from "./pi/service.ts";
import { createSessionSendMessageTool } from "./pi/tools.ts";

/** The live surface the messaging feature exposes to other features (search, sub-agents). */
export interface MessagingHandle {
  listSessionIds(): Promise<string[]>;
}

export function installMessaging(
  pi: ExtensionAPI,
  deps: { settings: SessionSettings; index: IndexHandle },
): MessagingHandle & SessionLifecycle {
  const incomingRuntime = new IncomingSessionMessageRuntime(pi);
  const service = new SessionMessagingService(deps.index.path, incomingRuntime);

  pi.registerTool(createSessionSendMessageTool(service));
  pi.registerMessageRenderer(SESSION_MESSAGE_CUSTOM_TYPE, renderIncomingSessionMessage);

  return {
    listSessionIds: () => service.listSessionIds(),
    async onSessionStart(_event, ctx) {
      incomingRuntime.bindContext(ctx);
      incomingRuntime.replayPending(ctx);
      try {
        await service.start(ctx);
      } catch {}
    },
    onSessionShutdown() {
      incomingRuntime.clearContext();
      service.stop();
    },
  };
}
