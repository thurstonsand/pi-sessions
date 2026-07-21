import { randomUUID } from "node:crypto";
import { defineTool, type ExtensionAPI, type SessionEntry } from "@earendil-works/pi-coding-agent";
import type { MessagingHandle } from "../session-messaging/install.ts";
import { formatError } from "../shared/errors.ts";
import {
  type SessionSubagentReportEnvelope,
  TASK_REPORT_SCHEMA,
} from "../shared/session-broker/protocol.ts";
import type { SubagentIdentity } from "./identity.ts";
import {
  collectParentLedger,
  SUBAGENT_REPORT_CUSTOM_TYPE,
  type SubagentReport,
  type SubagentReportMessage,
  type SubagentReportReceived,
} from "./ledger.ts";

export interface SubagentParentSession {
  sessionId: string;
  getBranch(): readonly SessionEntry[];
  isIdle(): boolean;
  epoch: number;
}

export interface ReportingSubagentSession extends SubagentParentSession {
  identity: SubagentIdentity;
}

export interface IncomingSubagentReport {
  receipt: SubagentReportReceived | undefined;
  message: SubagentReportMessage;
  content: string;
  delivery: { triggerTurn: true } | { deliverAs: "steer" };
}

export function createSubmitTaskReportTool(
  pi: ExtensionAPI,
  messaging: MessagingHandle,
  getSession: () => ReportingSubagentSession | undefined,
) {
  return defineTool({
    name: "submit_task_report",
    label: "Submit task report",
    description:
      "Send a report to the parent session and end the current turn. Use it when the delegated task or requested follow-up is done, blocked, or cannot be completed.",
    promptSnippet: "Submit the current task report to the parent session and end the turn",
    promptGuidelines: [
      "Call submit_task_report exactly once as the final tool call for every delegated task or follow-up that expects a response.",
      "Do not send task results through session_send_message; submit_task_report is the only supported means to send final results to the parent.",
      "If you receive steering instructions from the parent via session_send_message, you may optionally reply to the parent using the session_send_message tool if the parent's message calls for something that is out of band of what would be included in the report.",
    ],
    parameters: TASK_REPORT_SCHEMA,
    async execute(_toolCallId, params) {
      const session = getSession();
      if (!session) {
        throw new Error("submit_task_report is available only in its original subagent session.");
      }
      const summary = params.summary.trim();
      if (!summary) {
        throw new Error("submit_task_report requires a summary.");
      }

      const durableReport: SubagentReport = {
        reportId: randomUUID(),
        status: params.status,
        summary,
        ...(params.details ? { details: params.details } : {}),
        ...(params.references ? { references: params.references } : {}),
        ...(params.nextSteps ? { nextSteps: params.nextSteps } : {}),
      };
      pi.appendEntry(SUBAGENT_REPORT_CUSTOM_TYPE, durableReport);

      let delivered = false;
      let deliveryError: string | undefined;
      try {
        const result = await messaging.sendSubagentReport({
          target: session.identity.ownerSessionId,
          ...durableReport,
        });
        delivered = result.delivered;
        deliveryError = result.delivered ? undefined : result.error;
      } catch (error) {
        deliveryError = formatError(error);
      }

      const delivery = delivered
        ? "Report delivered to the parent."
        : `Report saved for later recovery${deliveryError ? `: ${deliveryError}` : "."}`;
      return {
        content: [{ type: "text" as const, text: `${delivery} Stopping.` }],
        details: { ...durableReport, delivered },
        terminate: true,
      };
    },
  });
}

export function buildIncomingSubagentReport(
  session: SubagentParentSession,
  envelope: SessionSubagentReportEnvelope,
): IncomingSubagentReport | undefined {
  const ownerSessionId = session.sessionId;
  const ledger = collectParentLedger(session.getBranch(), ownerSessionId);
  const launch = ledger.launches.find((candidate) => candidate.childSessionId === envelope.source);
  if (!launch) {
    throw new Error("Report source is not an owned subagent on the active branch.");
  }
  if (ledger.deliveredReportIds.has(envelope.reportId)) {
    return undefined;
  }

  const receipt = ledger.receivedReportIds.has(envelope.reportId)
    ? undefined
    : {
        writerSessionId: ownerSessionId,
        childSessionId: envelope.source,
        reportId: envelope.reportId,
      };
  const message: SubagentReportMessage = {
    writerSessionId: ownerSessionId,
    childSessionId: envelope.source,
    reportId: envelope.reportId,
    title: launch.title,
    status: envelope.status,
    summary: envelope.summary,
    ...(envelope.details ? { details: envelope.details } : {}),
    ...(envelope.references ? { references: envelope.references } : {}),
    ...(envelope.nextSteps ? { nextSteps: envelope.nextSteps } : {}),
    provenance: "live",
  };
  return {
    receipt,
    message,
    content: formatReportForModel(launch.title, message),
    delivery: session.isIdle() ? { triggerTurn: true } : { deliverAs: "steer" },
  };
}

export function formatReportForModel(title: string, report: SubagentReportMessage): string {
  const sections = [
    `Subagent report from "${title}" (session: ${report.childSessionId}, status: ${report.status})`,
    `Summary\n\n${report.summary}`,
  ];
  if (report.details) {
    sections.push(`Details\n\n${report.details}`);
  }
  if (report.references?.length) {
    const references = report.references.map((reference) =>
      reference.description
        ? `- ${reference.reference} — ${reference.description}`
        : `- ${reference.reference}`,
    );
    sections.push(`References\n\n${references.join("\n")}`);
  }
  if (report.nextSteps?.length) {
    sections.push(`Next steps\n\n${report.nextSteps.map((step) => `- ${step}`).join("\n")}`);
  }
  return sections.join("\n\n");
}
