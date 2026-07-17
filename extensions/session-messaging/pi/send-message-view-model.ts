import { normalizeOptionalText } from "../../shared/text.ts";
import type { SendMessageToolDetails } from "./message-contracts.ts";

export interface SendMessageRenderArgs {
  session?: string | undefined;
  message?: string | undefined;
  requestResponse?: boolean | undefined;
}

export interface SendingMessageViewModel {
  status: "sending";
  targetSessionId?: string | undefined;
  relation?: string | undefined;
  requestResponse: boolean;
  body: string;
}

export interface DeliveredMessageViewModel {
  status: "delivered";
  targetSessionId: string;
  targetSessionName?: string | undefined;
  relation?: string | undefined;
  requestResponse: boolean;
  body: string;
}

export type SendMessageViewModel = SendingMessageViewModel | DeliveredMessageViewModel;

export function buildSendingMessageView(
  args: SendMessageRenderArgs | undefined,
  relation: string | undefined,
): SendingMessageViewModel {
  return {
    status: "sending",
    targetSessionId: normalizeOptionalText(args?.session),
    relation,
    requestResponse: args?.requestResponse === true,
    body: args?.message ?? "",
  };
}

export function buildDeliveredMessageView(
  args: SendMessageRenderArgs | undefined,
  details: SendMessageToolDetails,
): DeliveredMessageViewModel {
  return {
    status: "delivered",
    targetSessionId: details.target.sessionId,
    targetSessionName: normalizeOptionalText(details.target.sessionName),
    relation: details.relation,
    requestResponse: args?.requestResponse === true,
    body: args?.message?.trim() ?? "",
  };
}
