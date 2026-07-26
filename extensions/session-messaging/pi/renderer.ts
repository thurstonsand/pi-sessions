import type { MessageRenderer } from "@earendil-works/pi-coding-agent";
import { Box } from "@earendil-works/pi-tui";
import { ExpandableContentLayout } from "../../shared/rendering/expandable-content-layout.ts";
import { safeParseTypeBoxValue } from "../../shared/typebox.ts";
import { buildIncomingMessagePresentation } from "./incoming-message-presenter.ts";
import { buildIncomingMessageView } from "./incoming-message-view-model.ts";
import { RECEIVED_MESSAGE_ENTRY_SCHEMA } from "./message-contracts.ts";

export const renderIncomingSessionMessage: MessageRenderer = (message, options, theme) => {
  const details = safeParseTypeBoxValue(RECEIVED_MESSAGE_ENTRY_SCHEMA, message.details);
  if (!details) {
    return undefined;
  }

  const layout = new ExpandableContentLayout(theme);
  layout.update(
    buildIncomingMessagePresentation(buildIncomingMessageView(details), theme),
    options.expanded,
  );
  const box = new Box(options.outputPad, 1, (text) => theme.bg("toolSuccessBg", text));
  box.addChild(layout);
  return box;
};
