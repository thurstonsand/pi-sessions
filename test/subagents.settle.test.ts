import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
  SUBAGENT_CLOSED_CUSTOM_TYPE,
  SUBAGENT_LAUNCHED_CUSTOM_TYPE,
  SUBAGENT_REPORT_CUSTOM_TYPE,
} from "../extensions/subagents/ledger.ts";
import { SubagentReconciler } from "../extensions/subagents/reconcile.ts";
import { createSettledChildLifecycle } from "../extensions/subagents/settle.ts";

describe("settled child recovery", () => {
  it("settles after a triggered report turn finishes before its original reconciliation", async () => {
    {
      let finishCleanup: (() => void) | undefined;
      let orphanExists = true;
      const branch: SessionEntry[] = [
        customEntry("launch", SUBAGENT_LAUNCHED_CUSTOM_TYPE, {
          writerSessionId: "aaaaaaaa-1234-1234-1234-123456789abc",
          childSessionId: "grandchild",
          childSessionFile: "/grandchild.jsonl",
          title: "Grandchild",
          goal: "Work",
          requestResponse: true,
          cwd: "/repo",
          resumeCommand: "resume",
          depth: 2,
        }),
      ];
      const report = { reportId: "grandchild-report", status: "done", summary: "Recovered." };
      const parent = {
        sessionId: "aaaaaaaa-1234-1234-1234-123456789abc",
        epoch: 1,
        getBranch: () => branch,
        isIdle: () => true,
        hasPendingMessages: () => false,
        shutdown: vi.fn(),
        reportError: vi.fn(),
      };
      const pi = {
        appendEntry: vi.fn(),
        sendMessage: vi.fn(),
        exec: vi.fn(async (_command: string, args: string[]) => {
          if (args[0] === "list-windows") {
            return {
              code: 0,
              stdout: orphanExists ? "@1\tOrphan\torphan\n" : "",
              stderr: "",
              killed: false,
            };
          }
          if (args[0] === "kill-window") {
            await new Promise<void>((resolve) => {
              finishCleanup = resolve;
            });
            orphanExists = false;
          }
          return { code: 0, stdout: "", stderr: "", killed: false };
        }),
      };
      const reconciler = new SubagentReconciler({
        executor: pi,
        messaging: { listSessions: async () => [], deliverTurnMessage: pi.sendMessage },
        getParent: () => parent,
        isCurrent: (epoch) => epoch === 1,
        openSession: () => ({
          getBranch: () => [customEntry("report", SUBAGENT_REPORT_CUSTOM_TYPE, report)],
        }),
      });
      const lifecycle = createSettledChildLifecycle(
        pi as never,
        reconciler,
        (epoch) => epoch === 1,
      );
      const child = {
        identity: {
          ownerSessionId: "bbbbbbbb-1234-1234-1234-123456789abc",
          childSessionId: "aaaaaaaa-1234-1234-1234-123456789abc",
          depth: 1,
          requestResponse: true,
        },
        requestResponse: true,
        reportsAtTurnStart: 0,
        paused: false,
      };

      const original = reconciler.reconcile();
      await vi.waitFor(() => expect(finishCleanup).toBeDefined());
      expect(pi.sendMessage).toHaveBeenCalledExactlyOnceWith(expect.anything());
      expect(reconciler.hasPendingRecoveredReports()).toBe(true);

      lifecycle.cancel();
      reconciler.noteReportDelivered(report.reportId);
      parent.isIdle = () => true;
      branch.push(
        customEntry("own-report", SUBAGENT_REPORT_CUSTOM_TYPE, {
          reportId: "child-report",
          status: "done",
          summary: "Processed the recovered report.",
        }),
      );
      const nextSettlement = reconciler.reconcile();
      expect(nextSettlement).toBe(original);
      finishCleanup?.();
      await lifecycle.settle(parent, child, await nextSettlement);

      expect(reconciler.hasPendingRecoveredReports()).toBe(false);
      expect(parent.shutdown).toHaveBeenCalledOnce();
      expect(pi.sendMessage).toHaveBeenCalledOnce();
      expect(pi.appendEntry).not.toHaveBeenCalledWith(
        SUBAGENT_CLOSED_CUSTOM_TYPE,
        expect.anything(),
      );
    }
  });
});

function customEntry(id: string, customType: string, data: unknown): SessionEntry {
  return {
    type: "custom",
    id,
    parentId: null,
    timestamp: "2026-03-25T00:00:00.000Z",
    customType,
    data,
  };
}
