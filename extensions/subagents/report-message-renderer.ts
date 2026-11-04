import type { MessageRenderer } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { parseSubagentReportMessage } from "./ledger.ts";
import { presentSubagentReportMessage } from "./report-message-presenter.ts";
import { buildSubagentReportMessageView } from "./report-message-view-model.ts";

export const renderSubagentReportMessage: MessageRenderer = (message, options, theme) => {
  const details = parseSubagentReportMessage(message.details);
  if (!details) {
    return undefined;
  }
  const report = buildSubagentReportMessageView(details);
  if (!report) {
    return undefined;
  }

  const box = new Box(options.outputPad, 1, (text) => theme.bg("customMessageBg", text));
  box.addChild(new Text(presentSubagentReportMessage(report, theme), 0, 0));
  return box;
};
