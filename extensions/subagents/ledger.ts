import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { TASK_REPORT_SCHEMA } from "../shared/session-broker/protocol.ts";
import { safeParseTypeBoxValue } from "../shared/typebox.ts";

export const SUBAGENT_LAUNCHED_CUSTOM_TYPE = "pi-sessions.subagent_launched";
export const SUBAGENT_REPORT_CUSTOM_TYPE = "pi-sessions.subagent_report";
export const SUBAGENT_REPORT_RECEIVED_CUSTOM_TYPE = "pi-sessions.subagent_report_received";
export const SUBAGENT_CLOSED_CUSTOM_TYPE = "pi-sessions.subagent_closed";
export const SUBAGENT_REPORT_REMINDER_MESSAGE_CUSTOM_TYPE = "pi-sessions.report_reminder_message";
export const SUBAGENT_CANCELLED_CUSTOM_TYPE = "pi-sessions.subagent_cancelled";
export const SUBAGENT_SUSPENDED_CUSTOM_TYPE = "pi-sessions.subagent_suspended";
export const SUBAGENT_OWNERSHIP_CLOSED_CUSTOM_TYPE = "pi-sessions.subagent_ownership_closed";
export const SUBAGENT_DISOWNED_NOTICE_CUSTOM_TYPE = "pi-sessions.subagent_disowned_notice";

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

export const SUBAGENT_CLOSED_SCHEMA = Type.Object({
  reason: Type.Union([
    Type.Literal("no_response_expected"),
    Type.Literal("no_report_after_reminder"),
  ]),
});

export const SUBAGENT_CANCELLED_SCHEMA = Type.Object({
  writerSessionId: Type.String(),
  childSessionId: Type.String(),
});
export const SUBAGENT_SUSPENDED_SCHEMA = Type.Object({
  writerSessionId: Type.String(),
  childSessionIds: Type.Array(Type.String()),
});
export const SUBAGENT_OWNERSHIP_CLOSED_SCHEMA = Type.Object({
  writerSessionId: Type.String(),
  childSessionId: Type.String(),
  reason: Type.Union([
    Type.Literal("report_received"),
    Type.Literal("no_response_expected"),
    Type.Literal("no_report_after_reminder"),
  ]),
});
export const SUBAGENT_DISOWNED_NOTICE_SCHEMA = Type.Object({
  writerSessionId: Type.String(),
});

export type SubagentLaunched = Static<typeof SUBAGENT_LAUNCHED_SCHEMA>;
export type SubagentReport = Static<typeof SUBAGENT_REPORT_SCHEMA>;
export type SubagentReportReceived = Static<typeof SUBAGENT_REPORT_RECEIVED_SCHEMA>;
export type SubagentClosed = Static<typeof SUBAGENT_CLOSED_SCHEMA>;
export type SubagentOwnershipClosureReason =
  | "report_received"
  | "no_response_expected"
  | "no_report_after_reminder";
export type SubagentOwnershipClosed = Static<typeof SUBAGENT_OWNERSHIP_CLOSED_SCHEMA>;

export interface ChildSubagentLifecycle {
  reports: readonly SubagentReport[];
  closed: SubagentClosed | undefined;
  hasReminder: boolean;
}

export interface ParentSubagentLedger {
  launches: readonly SubagentLaunched[];
  cancelledChildIds: ReadonlySet<string>;
  suspendedChildIds: ReadonlySet<string>;
  ownershipClosures: ReadonlyMap<string, SubagentOwnershipClosureReason>;
  receivedReportIds: ReadonlySet<string>;
  hasForeignLaunch: boolean;
  hasDisownedNotice: boolean;
}

export function hasSubagentLaunchEntries(branch: readonly SessionEntry[]): boolean {
  return branch.some(
    (entry) => entry.type === "custom" && entry.customType === SUBAGENT_LAUNCHED_CUSTOM_TYPE,
  );
}

export function findOwnedSubagentLaunch(
  branch: readonly SessionEntry[],
  ownerSessionId: string,
  childSessionId: string,
): SubagentLaunched | undefined {
  return collectParentLedger(branch, ownerSessionId).launches.find(
    (launch) => launch.childSessionId === childSessionId,
  );
}

export function collectParentLedger(
  branch: readonly SessionEntry[],
  ownerSessionId: string,
): ParentSubagentLedger {
  const launches = new Map<string, SubagentLaunched>();
  const cancelledChildIds = new Set<string>();
  const suspendedChildIds = new Set<string>();
  const ownershipClosures = new Map<string, SubagentOwnershipClosureReason>();
  const receivedReportIds = new Set<string>();
  let hasForeignLaunch = false;
  let hasDisownedNotice = false;

  for (const entry of branch) {
    if (entry.type !== "custom") {
      continue;
    }

    if (entry.customType === SUBAGENT_LAUNCHED_CUSTOM_TYPE) {
      const launch = safeParseTypeBoxValue(SUBAGENT_LAUNCHED_SCHEMA, entry.data);
      if (!launch) {
        continue;
      }
      if (launch.writerSessionId !== ownerSessionId) {
        hasForeignLaunch = true;
        continue;
      }
      launches.set(launch.childSessionId, launch);
      cancelledChildIds.delete(launch.childSessionId);
      suspendedChildIds.delete(launch.childSessionId);
      ownershipClosures.delete(launch.childSessionId);
      continue;
    }

    if (entry.customType === SUBAGENT_CANCELLED_CUSTOM_TYPE) {
      const cancellation = safeParseTypeBoxValue(SUBAGENT_CANCELLED_SCHEMA, entry.data);
      if (cancellation?.writerSessionId === ownerSessionId) {
        cancelledChildIds.add(cancellation.childSessionId);
      }
      continue;
    }

    if (entry.customType === SUBAGENT_SUSPENDED_CUSTOM_TYPE) {
      const suspension = safeParseTypeBoxValue(SUBAGENT_SUSPENDED_SCHEMA, entry.data);
      if (suspension?.writerSessionId === ownerSessionId) {
        for (const childSessionId of suspension.childSessionIds) {
          suspendedChildIds.add(childSessionId);
        }
      }
      continue;
    }

    if (entry.customType === SUBAGENT_OWNERSHIP_CLOSED_CUSTOM_TYPE) {
      const closure = safeParseTypeBoxValue(SUBAGENT_OWNERSHIP_CLOSED_SCHEMA, entry.data);
      if (closure?.writerSessionId === ownerSessionId) {
        ownershipClosures.set(closure.childSessionId, closure.reason);
      }
      continue;
    }

    if (entry.customType === SUBAGENT_REPORT_RECEIVED_CUSTOM_TYPE) {
      const receipt = safeParseTypeBoxValue(SUBAGENT_REPORT_RECEIVED_SCHEMA, entry.data);
      if (receipt?.writerSessionId === ownerSessionId) {
        receivedReportIds.add(receipt.reportId);
      }
      continue;
    }

    if (entry.customType === SUBAGENT_DISOWNED_NOTICE_CUSTOM_TYPE) {
      const notice = safeParseTypeBoxValue(SUBAGENT_DISOWNED_NOTICE_SCHEMA, entry.data);
      hasDisownedNotice ||= notice?.writerSessionId === ownerSessionId;
    }
  }

  return {
    launches: [...launches.values()],
    cancelledChildIds,
    suspendedChildIds,
    ownershipClosures,
    receivedReportIds,
    hasForeignLaunch,
    hasDisownedNotice,
  };
}

export function getChildSubagentLifecycle(branch: readonly SessionEntry[]): ChildSubagentLifecycle {
  const reports = new Map<string, SubagentReport>();
  let closed: SubagentClosed | undefined;
  let hasReminder = false;

  for (const entry of branch) {
    if (entry.type === "custom_message") {
      hasReminder ||= entry.customType === SUBAGENT_REPORT_REMINDER_MESSAGE_CUSTOM_TYPE;
      continue;
    }
    if (entry.type !== "custom") {
      continue;
    }
    if (entry.customType === SUBAGENT_REPORT_CUSTOM_TYPE) {
      const report = safeParseTypeBoxValue(SUBAGENT_REPORT_SCHEMA, entry.data);
      if (report) {
        reports.set(report.reportId, report);
      }
    } else if (entry.customType === SUBAGENT_CLOSED_CUSTOM_TYPE) {
      closed = safeParseTypeBoxValue(SUBAGENT_CLOSED_SCHEMA, entry.data) ?? closed;
    }
  }

  return { reports: [...reports.values()], closed, hasReminder };
}
