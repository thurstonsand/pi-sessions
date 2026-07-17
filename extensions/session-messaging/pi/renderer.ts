import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box } from "@earendil-works/pi-tui";
import { ExpandableContentLayout } from "../../shared/rendering/expandable-content-layout.ts";
import { safeParseTypeBoxValue } from "../../shared/typebox.ts";
import { buildIncomingMessagePresentation } from "./incoming-message-presenter.ts";
import { buildIncomingMessageView } from "./incoming-message-view-model.ts";
import { SESSION_MESSAGE_CUSTOM_TYPE } from "./incoming-runtime.ts";
import { RECEIVED_MESSAGE_ENTRY_SCHEMA } from "./message-contracts.ts";

export function registerSessionMessagingRenderer(pi: ExtensionAPI): void {
  pi.registerMessageRenderer(SESSION_MESSAGE_CUSTOM_TYPE, (message, options, theme) => {
    const details = safeParseTypeBoxValue(RECEIVED_MESSAGE_ENTRY_SCHEMA, message.details);
    if (!details) {
      return undefined;
    }

    const layout = new ExpandableContentLayout(theme);
    layout.update(
      buildIncomingMessagePresentation(buildIncomingMessageView(details), theme),
      options.expanded,
    );
    const box = new Box(1, 1, (text) => theme.bg("toolSuccessBg", text));
    box.addChild(layout);
    return box;
  });
}
