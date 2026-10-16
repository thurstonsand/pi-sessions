import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isSessionStarting, SESSION_STARTING_MESSAGE } from "../../session-handoff/metadata.ts";
import type { TurnMessage } from "../../shared/turn-delivery.ts";
import { safeParseTypeBoxValue } from "../../shared/typebox.ts";
import { RECEIVED_MESSAGE_ENTRY_SCHEMA, type ReceivedMessageEntry } from "./message-contracts.ts";

export const MESSAGE_RECEIVED_CUSTOM_TYPE = "pi-sessions.message_received";
export const SESSION_MESSAGE_CUSTOM_TYPE = "pi-sessions.session_message";

interface IncomingMessageActions {
  appendEntry(customType: string, data: unknown): void;
  deliver(message: TurnMessage): void;
}

export class IncomingSessionMessageRuntime {
  private context: ExtensionContext | undefined;
  private ready = false;
  private readonly actions: IncomingMessageActions;

  constructor(pi: ExtensionAPI, deliver: (message: TurnMessage) => void) {
    this.actions = {
      appendEntry: pi.appendEntry.bind(pi),
      deliver,
    };
  }

  bindContext(ctx: ExtensionContext): void {
    this.context = ctx;
    this.ready = false;
  }

  open(): void {
    this.replayPending(this.requireContext());
    this.ready = true;
  }

  clearContext(): void {
    this.context = undefined;
    this.ready = false;
  }

  deliver(received: ReceivedMessageEntry): void {
    const ctx = this.requireContext();
    // A starting session is broker-reachable but has not consumed its handoff
    // kickoff. Injecting here would land the message before the kickoff and
    // break the first-message invariant, so refuse delivery until it kicks off.
    if (isSessionStarting(ctx.sessionManager.getBranch())) {
      throw new Error(SESSION_STARTING_MESSAGE);
    }
    this.actions.appendEntry(MESSAGE_RECEIVED_CUSTOM_TYPE, received);
    // The broker connects before other features finish session_start, and a turn started now
    // would run without the tools they activate. The receipt is durable; open() replays it.
    if (this.ready) {
      this.inject(received);
    }
  }

  cancel(): void {
    this.requireContext().abort();
  }

  private replayPending(ctx: ExtensionContext): void {
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
        this.inject(received);
      }
    }
  }

  private requireContext(): ExtensionContext {
    if (!this.context) {
      throw new Error("Target session is not ready.");
    }
    return this.context;
  }

  private inject(received: ReceivedMessageEntry): void {
    this.actions.deliver({
      customType: SESSION_MESSAGE_CUSTOM_TYPE,
      content: formatIncomingMessageForModel(received),
      display: true,
      details: received,
    });
  }
}

function formatIncomingMessageForModel(received: ReceivedMessageEntry): string {
  const title = received.source.sessionName?.trim();
  const titlePart = title ? ` "${title}"` : "";
  const relationPart = received.relation ? `, relation: ${received.relation}` : "";
  const responseLine = received.requestResponse ? "\n\nResponse requested." : "";
  return `Incoming message from session${titlePart} (session: ${received.source.sessionId}${relationPart}):\n\n${received.body}${responseLine}`;
}
