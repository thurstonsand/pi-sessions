import { describe, expect, it, vi } from "vitest";
import type { MessagingHandle } from "../extensions/session-messaging/install.ts";
import type {
  SendSubagentReportRequest,
  SendSubagentReportResult,
} from "../extensions/session-messaging/pi/service.ts";
import { SUBAGENT_LAUNCHED_CUSTOM_TYPE } from "../extensions/subagents/ledger.ts";
import {
  buildIncomingSubagentReport,
  createSubmitTaskReportTool,
} from "../extensions/subagents/report.ts";
import { createFakeExtensionApi } from "./test-helpers.ts";

const parentId = "parent-session";
const childId = "child-session";

function createMessagingHandle(
  sendSubagentReport: (request: SendSubagentReportRequest) => Promise<SendSubagentReportResult>,
): MessagingHandle {
  return {
    sendMessage: vi.fn(),
    sendSubagentReport: vi.fn(sendSubagentReport),
    cancelSession: vi.fn(),
    listSessions: vi.fn(),
    waitForSession: vi.fn(),
    getCachedRelationTo: vi.fn(),
    onIncomingMessage: vi.fn(),
    onIncomingCancel: vi.fn(),
    onIncomingSubagentReport: vi.fn(),
  };
}

describe("subagent reports", () => {
  it("writes the child report before attempting broker delivery and terminates the turn", async () => {
    const order: string[] = [];
    const pi = createFakeExtensionApi();
    vi.mocked(pi.appendEntry).mockImplementation(() => {
      order.push("append");
      return "entry-1";
    });
    const messaging = createMessagingHandle(async () => {
      order.push("send");
      return { delivered: false, error: "Parent is not live." };
    });
    const tool = createSubmitTaskReportTool(pi, messaging, () => ({
      epoch: 1,
      sessionId: childId,
      getBranch: () => [],
      isIdle: () => true,
      identity: {
        childSessionId: childId,
        ownerSessionId: parentId,
        parentSessionFile: "/tmp/parent.jsonl",
        depth: 1,
        requestResponse: true,
      },
    }));

    const result = await tool.execute(
      "call-1",
      {
        status: "done",
        summary: "  Tests pass.  ",
        details: "Validated locally.",
        references: [{ reference: "test/example.test.ts", description: "Passing test" }],
        nextSteps: ["Merge the change."],
      },
      undefined,
      undefined,
      {} as never,
    );

    expect(order).toEqual(["append", "send"]);
    expect(pi.appendEntry).toHaveBeenCalledWith(
      "pi-sessions.subagent_report",
      expect.objectContaining({
        status: "done",
        summary: "Tests pass.",
        details: "Validated locally.",
      }),
    );
    expect(messaging.sendSubagentReport).toHaveBeenCalledWith(
      expect.objectContaining({
        target: parentId,
        status: "done",
        summary: "Tests pass.",
      }),
    );
    expect(result).toMatchObject({ terminate: true });
  });

  it("builds an owned parent receipt and model-visible report", () => {
    const incoming = buildIncomingSubagentReport(
      {
        sessionId: parentId,
        getBranch: () => [launchEntry()] as never,
        isIdle: () => true,
        epoch: 1,
      },
      {
        kind: "subagent_report",
        reportId: "report-1",
        source: childId,
        target: parentId,
        status: "done",
        summary: "Implemented and tested.",
        details: "The focused checks pass.",
        references: [{ reference: "test/example.test.ts", description: "Coverage" }],
        nextSteps: ["Review the diff."],
        sentAt: "2026-03-25T00:00:00.000Z",
      },
    );

    expect(incoming).toEqual({
      receipt: {
        writerSessionId: parentId,
        childSessionId: childId,
        reportId: "report-1",
      },
      message: {
        writerSessionId: parentId,
        childSessionId: childId,
        reportId: "report-1",
        title: "Implement phase",
        status: "done",
        summary: "Implemented and tested.",
        details: "The focused checks pass.",
        references: [{ reference: "test/example.test.ts", description: "Coverage" }],
        nextSteps: ["Review the diff."],
        provenance: "live",
      },
      content: `Subagent report from "Implement phase" (session: ${childId}, status: done)

Summary

Implemented and tested.

Details

The focused checks pass.

References

- test/example.test.ts — Coverage

Next steps

- Review the diff.`,
      delivery: { triggerTurn: true },
    });
    expect(incoming?.content.split("\n", 1)[0]).toBe(
      `Subagent report from "Implement phase" (session: ${childId}, status: done)`,
    );
  });

  it("replays a report that was accepted but not injected", () => {
    const incoming = buildIncomingSubagentReport(
      {
        epoch: 1,
        sessionId: parentId,
        getBranch: () => [launchEntry(), receivedEntry()] as never,
        isIdle: () => false,
      },
      {
        kind: "subagent_report",
        reportId: "report-1",
        source: childId,
        target: parentId,
        status: "done",
        summary: "Retry after receipt.",
        sentAt: "2026-03-25T00:00:00.000Z",
      },
    );

    expect(incoming).toMatchObject({
      receipt: undefined,
      message: { reportId: "report-1", summary: "Retry after receipt." },
      delivery: { deliverAs: "steer" },
    });
  });

  it("deduplicates a report already injected on the active branch", () => {
    const incoming = buildIncomingSubagentReport(
      {
        epoch: 1,
        sessionId: parentId,
        getBranch: () => [launchEntry(), receivedEntry(), deliveredEntry()] as never,
        isIdle: () => true,
      },
      {
        kind: "subagent_report",
        reportId: "report-1",
        source: childId,
        target: parentId,
        status: "done",
        summary: "Duplicate.",
        sentAt: "2026-03-25T00:00:00.000Z",
      },
    );

    expect(incoming).toBeUndefined();
  });

  it("does not grant ownership to a fork that copied another writer's launch", () => {
    expect(() =>
      buildIncomingSubagentReport(
        {
          epoch: 1,
          sessionId: "fork-session",
          getBranch: () => [launchEntry()] as never,
          isIdle: () => true,
        },
        {
          kind: "subagent_report",
          reportId: "forked",
          source: childId,
          target: "fork-session",
          status: "done",
          summary: "Wrong owner.",
          sentAt: "2026-03-25T00:00:00.000Z",
        },
      ),
    ).toThrow("not an owned subagent");
  });

  it("rejects a report after rewinding above its launch", () => {
    expect(() =>
      buildIncomingSubagentReport(
        {
          epoch: 1,
          sessionId: parentId,
          getBranch: () => [] as never,
          isIdle: () => true,
        },
        {
          kind: "subagent_report",
          reportId: "rewound",
          source: childId,
          target: parentId,
          status: "done",
          summary: "Trust me.",
          sentAt: "2026-03-25T00:00:00.000Z",
        },
      ),
    ).toThrow("not an owned subagent");
  });
});

function receivedEntry() {
  return {
    type: "custom",
    id: "received-1",
    parentId: "launch-1",
    timestamp: "2026-03-25T00:01:00.000Z",
    customType: "pi-sessions.subagent_report_received",
    data: {
      writerSessionId: parentId,
      childSessionId: childId,
      reportId: "report-1",
    },
  };
}

function deliveredEntry() {
  return {
    type: "custom_message",
    id: "delivered-1",
    parentId: "received-1",
    timestamp: "2026-03-25T00:01:01.000Z",
    customType: "pi-sessions.subagent_report_message",
    content: "Delivered.",
    display: true,
    details: {
      writerSessionId: parentId,
      childSessionId: childId,
      reportId: "report-1",
      status: "done",
      summary: "Implemented and tested.",
      provenance: "live",
    },
  };
}

function launchEntry() {
  return {
    type: "custom",
    id: "launch-1",
    parentId: null,
    timestamp: "2026-03-25T00:00:00.000Z",
    customType: SUBAGENT_LAUNCHED_CUSTOM_TYPE,
    data: {
      writerSessionId: parentId,
      childSessionId: childId,
      childSessionFile: "/tmp/child.jsonl",
      title: "Implement phase",
      goal: "Implement it",
      requestResponse: true,
      model: "openai/gpt-5.4",
      cwd: "/repo",
      resumeCommand: "pi --session-id child-session",
      depth: 1,
    },
  };
}
