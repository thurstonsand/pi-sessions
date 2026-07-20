import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  collectParentLedger,
  getChildSubagentLifecycle,
  SUBAGENT_CANCELLED_CUSTOM_TYPE,
  SUBAGENT_CLOSED_CUSTOM_TYPE,
  SUBAGENT_DISOWNED_MESSAGE_CUSTOM_TYPE,
  SUBAGENT_LAUNCHED_CUSTOM_TYPE,
  SUBAGENT_REPORT_MESSAGE_CUSTOM_TYPE,
  SUBAGENT_REPORT_RECEIVED_CUSTOM_TYPE,
  SUBAGENT_REPORT_REMINDER_MESSAGE_CUSTOM_TYPE,
  SUBAGENT_SUSPENDED_CUSTOM_TYPE,
} from "../extensions/subagents/ledger.ts";

const ownerId = "12345678-1234-1234-1234-123456789abc";
const childId = "87654321-1234-1234-1234-123456789abc";
let entryId = 0;

describe("subagent ledgers", () => {
  it("folds parent lifecycle records and lets a later launch supersede terminal state", () => {
    const entries = [
      launchEntry(),
      customEntry(SUBAGENT_CANCELLED_CUSTOM_TYPE, {
        writerSessionId: ownerId,
        childSessionId: childId,
      }),
      customEntry(SUBAGENT_SUSPENDED_CUSTOM_TYPE, {
        writerSessionId: ownerId,
        childSessionIds: [childId],
      }),
      customEntry(SUBAGENT_REPORT_RECEIVED_CUSTOM_TYPE, {
        writerSessionId: ownerId,
        childSessionId: childId,
        reportId: "report-1",
      }),
      customMessage(SUBAGENT_REPORT_MESSAGE_CUSTOM_TYPE, {
        writerSessionId: ownerId,
        childSessionId: childId,
        reportId: "report-1",
        status: "done",
        summary: "Complete.",
        provenance: "live",
      }),
      launchEntry(),
    ];

    const ledger = collectParentLedger(entries, ownerId);

    expect(ledger.launches).toHaveLength(1);
    expect(ledger.cancelledChildIds).not.toContain(childId);
    expect(ledger.suspendedChildIds).not.toContain(childId);
    expect(ledger.receivedReportIds).toContain("report-1");
    expect(ledger.deliveredReportIds).toContain("report-1");
  });

  it("collects fork evidence independently from owned launches", () => {
    const entries = [
      launchEntry("aaaaaaaa-1234-1234-1234-123456789abc"),
      launchEntry(),
      customMessage(SUBAGENT_DISOWNED_MESSAGE_CUSTOM_TYPE, { writerSessionId: ownerId }),
    ];

    const ledger = collectParentLedger(entries, ownerId);

    expect(ledger.launches).toHaveLength(1);
    expect(ledger.hasForeignLaunch).toBe(true);
    expect(ledger.hasDisownedNotice).toBe(true);
  });

  it("uses the durable reminder message as the one-shot marker", () => {
    const branch: SessionEntry[] = [
      {
        type: "custom_message",
        id: "reminder",
        parentId: null,
        timestamp: "2026-03-25T00:00:00.000Z",
        customType: SUBAGENT_REPORT_REMINDER_MESSAGE_CUSTOM_TYPE,
        content: "Submit a report.",
        display: true,
      },
      customEntry(SUBAGENT_CLOSED_CUSTOM_TYPE, { reason: "no_report_after_reminder" }),
    ];

    expect(getChildSubagentLifecycle(branch)).toMatchObject({
      hasReminder: true,
      closed: { reason: "no_report_after_reminder" },
    });
  });
});

function launchEntry(writerSessionId = ownerId): SessionEntry {
  return customEntry(SUBAGENT_LAUNCHED_CUSTOM_TYPE, {
    writerSessionId,
    childSessionId: childId,
    childSessionFile: "/tmp/child.jsonl",
    title: "Child",
    goal: "Work",
    requestResponse: true,
    cwd: "/repo",
    resumeCommand: "resume",
    depth: 1,
  });
}

function customMessage(customType: string, details: unknown): SessionEntry {
  return {
    type: "custom_message",
    id: `${customType}-${entryId++}`,
    parentId: null,
    timestamp: "2026-03-25T00:00:00.000Z",
    customType,
    content: "message",
    display: true,
    details,
  };
}

function customEntry(customType: string, data: unknown): SessionEntry {
  return {
    type: "custom",
    id: `${customType}-${entryId++}`,
    parentId: null,
    timestamp: "2026-03-25T00:00:00.000Z",
    customType,
    data,
  };
}
