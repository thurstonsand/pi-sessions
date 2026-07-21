import type { MessageRenderer } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";
import { safeParseTypeBoxValue } from "../shared/typebox.ts";
import { SUBAGENT_REPORT_MESSAGE_SCHEMA } from "./ledger.ts";
import { presentSubagentReportMessage } from "./report-message-presenter.ts";
import { buildSubagentReportMessageView } from "./report-message-view-model.ts";

export const renderSubagentReportMessage: MessageRenderer = (message, _options, theme) => {
  const details = safeParseTypeBoxValue(SUBAGENT_REPORT_MESSAGE_SCHEMA, message.details);
  if (!details) {
    return undefined;
  }
  const report = buildSubagentReportMessageView(details);
  if (!report) {
    return undefined;
  }

  const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
  box.addChild(new Text(presentSubagentReportMessage(report, theme), 0, 0));
  return box;
};
