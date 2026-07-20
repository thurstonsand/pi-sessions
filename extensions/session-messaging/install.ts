import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { IndexHandle, SessionLifecycle } from "../shared/composition.ts";
import type { SessionSettings } from "../shared/settings.ts";
import {
  IncomingSessionMessageRuntime,
  SESSION_MESSAGE_CUSTOM_TYPE,
} from "./pi/incoming-runtime.ts";
import { renderIncomingSessionMessage } from "./pi/renderer.ts";
import {
  type CancelSessionResult,
  type IncomingCancelHandler,
  type IncomingMessageHandler,
  type IncomingSubagentReportHandler,
  type SendMessageRequest,
  type SendMessageResult,
  type SendSubagentReportRequest,
  type SendSubagentReportResult,
  SessionMessagingService,
} from "./pi/service.ts";

export type {
  CancelSessionResult,
  SendMessageRequest,
  SendMessageResult,
} from "./pi/service.ts";

/** The live surface the messaging feature exposes to other features (search, subagents). */
export interface MessagingHandle {
  sendMessage(request: SendMessageRequest): Promise<SendMessageResult>;
  sendSubagentReport(request: SendSubagentReportRequest): Promise<SendSubagentReportResult>;
  cancelSession(sessionId: string): Promise<CancelSessionResult>;
  listSessions(): Promise<string[]>;
  waitForSession(sessionId: string, timeoutMs: number): Promise<boolean>;
  getCachedRelationTo(sessionId: string | undefined): string | undefined;
  onIncomingMessage(handler: IncomingMessageHandler): void;
  onIncomingCancel(handler: IncomingCancelHandler): void;
  onIncomingSubagentReport(handler: IncomingSubagentReportHandler): void;
}

export function installMessaging(
  pi: ExtensionAPI,
  deps: { settings: SessionSettings; index: IndexHandle },
): MessagingHandle & SessionLifecycle {
  const incomingRuntime = new IncomingSessionMessageRuntime(pi);
  const service = new SessionMessagingService(deps.index.path);

  service.onIncomingMessage((envelope) => {
    incomingRuntime.deliver(service.buildReceivedMessage(envelope));
  });
  service.onIncomingCancel(() => {
    incomingRuntime.cancel();
  });

  pi.registerMessageRenderer(SESSION_MESSAGE_CUSTOM_TYPE, renderIncomingSessionMessage);

  return {
    sendMessage: (request) => service.sendMessage(request),
    sendSubagentReport: (request) => service.sendSubagentReport(request),
    cancelSession: (sessionId) => service.cancelSession(sessionId),
    listSessions: () => service.listSessions(),
    waitForSession: (sessionId, timeoutMs) => service.waitForSession(sessionId, timeoutMs),
    getCachedRelationTo: (sessionId) => service.getCachedRelationTo(sessionId),
    onIncomingMessage: (handler) => service.onIncomingMessage(handler),
    onIncomingCancel: (handler) => service.onIncomingCancel(handler),
    onIncomingSubagentReport: (handler) => service.onIncomingSubagentReport(handler),
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
