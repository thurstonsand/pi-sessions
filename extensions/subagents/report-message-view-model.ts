import type { TaskReportReference } from "../shared/session-broker/protocol.ts";
import type { SubagentReportMessage } from "./ledger.ts";

export interface SubagentReportMessageViewModel {
  title: string;
  status: SubagentReportMessage["status"];
  summary: string;
  details?: string | undefined;
  references: readonly TaskReportReference[];
  nextSteps: readonly string[];
}

export function buildSubagentReportMessageView(
  report: SubagentReportMessage,
): SubagentReportMessageViewModel | undefined {
  const title = report.title?.trim();
  if (!title) {
    return undefined;
  }

  return {
    title,
    status: report.status,
    summary: report.summary,
    details: report.details,
    references: report.references ?? [],
    nextSteps: report.nextSteps ?? [],
  };
}
