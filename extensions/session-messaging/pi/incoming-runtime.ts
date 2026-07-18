import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { safeParseTypeBoxValue } from "../../shared/typebox.ts";
import { RECEIVED_MESSAGE_ENTRY_SCHEMA, type ReceivedMessageEntry } from "./message-contracts.ts";

export const MESSAGE_RECEIVED_CUSTOM_TYPE = "pi-sessions.message_received";
export const SESSION_MESSAGE_CUSTOM_TYPE = "pi-sessions.session_message";

interface IncomingMessageActions {
  appendEntry(customType: string, data: unknown): void;
  sendMessage(
    message: {
      customType: string;
      content: string;
      display: boolean;
      details: unknown;
    },
    options: { triggerTurn: true } | { deliverAs: "steer" },
  ): void;
}

export class IncomingSessionMessageRuntime {
  private context: ExtensionContext | undefined;
  private readonly actions: IncomingMessageActions;

  constructor(pi: ExtensionAPI) {
    this.actions = {
      appendEntry: pi.appendEntry.bind(pi),
      sendMessage: pi.sendMessage.bind(pi),
    };
  }

  bindContext(ctx: ExtensionContext): void {
    this.context = ctx;
  }

  clearContext(): void {
    this.context = undefined;
  }

  deliver(received: ReceivedMessageEntry): void {
    const ctx = this.requireContext();
    this.actions.appendEntry(MESSAGE_RECEIVED_CUSTOM_TYPE, received);
    this.inject(ctx, received);
  }

  cancel(): void {
    this.requireContext().abort();
  }

  replayPending(ctx: ExtensionContext): void {
    const entries = ctx.sessionManager.getEntries();
    const deliveredMessageIds = new Set<string>();
    const pendingReceipts: ReceivedMessageEntry[] = [];

    for (const entry of entries) {
      if (entry.type === "custom_message" && entry.customType === SESSION_MESSAGE_CUSTOM_TYPE) {
        const delivered = safeParseTypeBoxValue(RECEIVED_MESSAGE_ENTRY_SCHEMA, entry.details);
        if (delivered) {
          deliveredMessageIds.add(delivered.messageId);
        }
        continue;
      }

      if (entry.type !== "custom" || entry.customType !== MESSAGE_RECEIVED_CUSTOM_TYPE) {
        continue;
      }

      const received = safeParseTypeBoxValue(RECEIVED_MESSAGE_ENTRY_SCHEMA, entry.data);
      if (received) {
        pendingReceipts.push(received);
      }
    }

    for (const received of pendingReceipts) {
      if (!deliveredMessageIds.has(received.messageId)) {
        this.inject(ctx, received);
      }
    }
  }

  private requireContext(): ExtensionContext {
    if (!this.context) {
      throw new Error("Target session is not ready.");
    }
    return this.context;
  }

  private inject(ctx: ExtensionContext, received: ReceivedMessageEntry): void {
    const deliveryOptions = ctx.isIdle()
      ? { triggerTurn: true as const }
      : { deliverAs: "steer" as const };

    this.actions.sendMessage(
      {
        customType: SESSION_MESSAGE_CUSTOM_TYPE,
        content: formatIncomingMessageForModel(received),
        display: true,
        details: received,
      },
      deliveryOptions,
    );
  }
}

function formatIncomingMessageForModel(received: ReceivedMessageEntry): string {
  const title = received.source.sessionName?.trim();
  const titlePart = title ? ` "${title}"` : "";
  const relationPart = received.relation ? `, relation: ${received.relation}` : "";
  const responseLine = received.requestResponse ? "\n\nResponse requested." : "";
  return `Incoming message from session${titlePart} (session: ${received.source.sessionId}${relationPart}):\n\n${received.body}${responseLine}`;
}
