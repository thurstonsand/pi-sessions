import { normalizeOptionalText } from "../../shared/text.ts";
import type { ReceivedMessageEntry } from "./message-contracts.ts";

export interface IncomingMessageViewModel {
  sourceSessionId: string;
  sourceSessionName?: string | undefined;
  relation?: string | undefined;
  requestResponse: boolean;
  body: string;
}

export function buildIncomingMessageView(received: ReceivedMessageEntry): IncomingMessageViewModel {
  return {
    sourceSessionId: received.source.sessionId,
    sourceSessionName: normalizeOptionalText(received.source.sessionName),
    relation: received.relation,
    requestResponse: received.requestResponse === true,
    body: received.body,
  };
}
