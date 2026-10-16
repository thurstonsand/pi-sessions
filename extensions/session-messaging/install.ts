import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { IndexHandle, SessionLifecycle } from "../shared/composition.ts";
import type { SessionSettings } from "../shared/settings.ts";
import { type TurnMessage, TurnMessageDelivery } from "../shared/turn-delivery.ts";
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
  /** Delivers a message this session must act on, holding it while a compaction runs. */
  deliverTurnMessage(message: TurnMessage): void;
  /** Whether a delivered message is still waiting for the session to take it. */
  hasHeldTurnMessages(): boolean;
}

export function installMessaging(
  pi: ExtensionAPI,
  deps: { settings: SessionSettings; index: IndexHandle },
): MessagingHandle & SessionLifecycle {
  const turnDelivery = new TurnMessageDelivery(pi.sendMessage.bind(pi));
  const incomingRuntime = new IncomingSessionMessageRuntime(pi, (message) =>
    turnDelivery.deliver(message),
  );
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
    deliverTurnMessage: (message) => turnDelivery.deliver(message),
    hasHeldTurnMessages: () => turnDelivery.hasHeld(),
    async onSessionStart(_event, ctx) {
      turnDelivery.bind(ctx);
      incomingRuntime.bindContext(ctx);
      try {
        await service.start(ctx);
      } catch {}
    },
    onSessionReady() {
      incomingRuntime.open();
    },
    onSessionShutdown() {
      turnDelivery.clear();
      incomingRuntime.clearContext();
      service.stop();
    },
  };
}
