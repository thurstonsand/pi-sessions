import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { TASK_REPORT_SCHEMA } from "../shared/session-broker/protocol.ts";
import { safeParseTypeBoxValue } from "../shared/typebox.ts";

export const SUBAGENT_LAUNCHED_CUSTOM_TYPE = "pi-sessions.subagent_launched";
export const SUBAGENT_REPORT_CUSTOM_TYPE = "pi-sessions.subagent_report";
export const SUBAGENT_REPORT_RECEIVED_CUSTOM_TYPE = "pi-sessions.subagent_report_received";

export const SUBAGENT_LAUNCHED_SCHEMA = Type.Object({
  writerSessionId: Type.String(),
  childSessionId: Type.String(),
  childSessionFile: Type.String(),
  title: Type.String(),
  goal: Type.String(),
  requestResponse: Type.Boolean(),
  model: Type.Optional(Type.String()),
  cwd: Type.String(),
  resumeCommand: Type.String(),
  depth: Type.Integer({ minimum: 1 }),
});

export const SUBAGENT_REPORT_SCHEMA = Type.Intersect([
  Type.Object({ reportId: Type.String() }),
  TASK_REPORT_SCHEMA,
]);

export const SUBAGENT_REPORT_RECEIVED_SCHEMA = Type.Intersect([
  Type.Object({
    writerSessionId: Type.String(),
    childSessionId: Type.String(),
    reportId: Type.String(),
    provenance: Type.Union([Type.Literal("live"), Type.Literal("recovered")]),
  }),
  TASK_REPORT_SCHEMA,
]);

export type SubagentLaunched = Static<typeof SUBAGENT_LAUNCHED_SCHEMA>;
export type SubagentReport = Static<typeof SUBAGENT_REPORT_SCHEMA>;
export type SubagentReportReceived = Static<typeof SUBAGENT_REPORT_RECEIVED_SCHEMA>;

export function findOwnedSubagentLaunch(
  branch: readonly SessionEntry[],
  ownerSessionId: string,
  childSessionId: string,
): SubagentLaunched | undefined {
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index];
    if (entry?.type !== "custom" || entry.customType !== SUBAGENT_LAUNCHED_CUSTOM_TYPE) {
      continue;
    }
    const launch = safeParseTypeBoxValue(SUBAGENT_LAUNCHED_SCHEMA, entry.data);
    if (launch?.writerSessionId === ownerSessionId && launch.childSessionId === childSessionId) {
      return launch;
    }
  }
  return undefined;
}

export function hasReceivedSubagentReport(
  branch: readonly SessionEntry[],
  ownerSessionId: string,
  reportId: string,
): boolean {
  return branch.some((entry) => {
    if (entry.type !== "custom" || entry.customType !== SUBAGENT_REPORT_RECEIVED_CUSTOM_TYPE) {
      return false;
    }
    const receipt = safeParseTypeBoxValue(SUBAGENT_REPORT_RECEIVED_SCHEMA, entry.data);
    return receipt?.writerSessionId === ownerSessionId && receipt.reportId === reportId;
  });
}
