import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { safeParseTypeBoxValue } from "../../shared/typebox.ts";
import { SESSION_MESSAGE_CUSTOM_TYPE } from "./incoming-runtime.ts";
import { RECEIVED_MESSAGE_ENTRY_SCHEMA } from "./message-contracts.ts";
import { createReceivedSessionMessageComponent } from "./message-view.ts";

export function registerSessionMessagingRenderer(pi: ExtensionAPI): void {
  pi.registerMessageRenderer(SESSION_MESSAGE_CUSTOM_TYPE, (message, options, theme) => {
    const details = safeParseTypeBoxValue(RECEIVED_MESSAGE_ENTRY_SCHEMA, message.details);
    if (!details) {
      return undefined;
    }

    return createReceivedSessionMessageComponent(details, options.expanded, theme);
  });
}
