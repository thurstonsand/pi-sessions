import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
  SUBAGENT_CANCELLED_CUSTOM_TYPE,
  SUBAGENT_DISOWNED_MESSAGE_CUSTOM_TYPE,
  SUBAGENT_LAUNCHED_CUSTOM_TYPE,
  SUBAGENT_REPORT_CUSTOM_TYPE,
  SUBAGENT_REPORT_MESSAGE_CUSTOM_TYPE,
  SUBAGENT_REPORT_RECEIVED_CUSTOM_TYPE,
  SUBAGENT_SUSPENDED_CUSTOM_TYPE,
} from "../extensions/subagents/ledger.ts";
import { SubagentReconciler } from "../extensions/subagents/reconcile.ts";

const parentId = "12345678-1234-1234-1234-123456789abc";
const childId = "87654321-1234-1234-1234-123456789abc";

describe("subagent reconciliation", () => {
  it("recovers a missed report and wakes an idle parent with its contents", async () => {
    const fixture = createFixture([launchEntry()], [reportEntry()]);

    await fixture.reconciler.reconcile();

    expect(fixture.appended.map((entry) => entry.customType)).toEqual([
      SUBAGENT_REPORT_RECEIVED_CUSTOM_TYPE,
    ]);
    expect(fixture.appended[0]?.data).toEqual({
      writerSessionId: parentId,
      childSessionId: childId,
      reportId: "report-1",
    });
    expect(fixture.sent).toEqual([
      expect.objectContaining({
        message: expect.objectContaining({
          customType: SUBAGENT_REPORT_MESSAGE_CUSTOM_TYPE,
          content: expect.stringContaining("Complete."),
          details: expect.objectContaining({ reportId: "report-1", provenance: "recovered" }),
        }),
        options: { triggerTurn: true },
      }),
    ]);
  });

  it("replays an accepted report whose visible message was not injected", async () => {
    const fixture = createFixture(
      [
        launchEntry(),
        customEntry("receipt", SUBAGENT_REPORT_RECEIVED_CUSTOM_TYPE, {
          writerSessionId: parentId,
          childSessionId: childId,
          reportId: "report-1",
        }),
      ],
      [reportEntry()],
      false,
      async () => [],
      false,
      true,
      false,
    );

    await fixture.reconciler.reconcile();

    expect(fixture.appended).toEqual([]);
    expect(fixture.sent[0]).toMatchObject({ options: { deliverAs: "steer" } });
  });

  it("restores only a durably suspended child when restoration is requested", async () => {
    const fixture = createFixture(
      [
        launchEntry(),
        customEntry("suspend", SUBAGENT_SUSPENDED_CUSTOM_TYPE, {
          writerSessionId: parentId,
          childSessionIds: [childId],
        }),
      ],
      [],
    );

    await fixture.reconciler.reconcile();
    expect(fixture.created()).toBe(0);

    await fixture.reconciler.reconcileAndRestoreSuspended();
    expect(fixture.created()).toBe(1);
    expect(fixture.appended.at(-1)?.customType).toBe(SUBAGENT_LAUNCHED_CUSTOM_TYPE);
  });

  it("reports post-mutation state from the same evidence classifier", async () => {
    const fixture = createFixture(
      [
        launchEntry(),
        customEntry("cancel", SUBAGENT_CANCELLED_CUSTOM_TYPE, {
          writerSessionId: parentId,
          childSessionId: childId,
        }),
      ],
      [],
      true,
    );

    const result = await fixture.reconciler.reconcile();

    expect(result.states.get(childId)).toBe("stopped");
    expect(fixture.killed()).toBe(1);
  });

  it("reports completion when a child report races cancellation", async () => {
    const fixture = createFixture(
      [
        launchEntry(),
        customEntry("cancel", SUBAGENT_CANCELLED_CUSTOM_TYPE, {
          writerSessionId: parentId,
          childSessionId: childId,
        }),
      ],
      [reportEntry()],
    );

    const result = await fixture.reconciler.reconcile();

    expect(result.states.get(childId)).toBe("completed");
    expect(fixture.killed()).toBe(0);
  });

  it("keeps failed teardown classified as stopping", async () => {
    const fixture = createFixture(
      [
        launchEntry(),
        customEntry("cancel", SUBAGENT_CANCELLED_CUSTOM_TYPE, {
          writerSessionId: parentId,
          childSessionId: childId,
        }),
      ],
      [],
      true,
      async () => [],
      false,
      false,
    );

    const result = await fixture.reconciler.reconcile();

    expect(result.states.get(childId)).toBe("stopping");
    expect(fixture.windowExists()).toBe(true);
  });

  it("drains cancellation behind an in-flight restore before returning state", async () => {
    const fixture = createFixture(
      [
        launchEntry(),
        customEntry("suspend", SUBAGENT_SUSPENDED_CUSTOM_TYPE, {
          writerSessionId: parentId,
          childSessionIds: [childId],
        }),
      ],
      [],
      false,
      async () => [],
      true,
    );

    const restore = fixture.reconciler.reconcileAndRestoreSuspended();
    await vi.waitFor(() => expect(fixture.releaseCreate).toBeDefined());
    fixture.append(SUBAGENT_CANCELLED_CUSTOM_TYPE, {
      writerSessionId: parentId,
      childSessionId: childId,
    });
    const cancellation = fixture.reconciler.reconcile();
    expect(cancellation).toBe(restore);

    fixture.releaseCreate?.();
    const result = await cancellation;

    expect(result.states.get(childId)).toBe("stopped");
    expect(fixture.created()).toBe(1);
    expect(fixture.killed()).toBe(1);
    expect(fixture.windowExists()).toBe(false);
  });

  it("waits for in-flight reconciliation before suspending and killing", async () => {
    const fixture = createFixture(
      [
        launchEntry(),
        customEntry("suspend", SUBAGENT_SUSPENDED_CUSTOM_TYPE, {
          writerSessionId: parentId,
          childSessionIds: [childId],
        }),
      ],
      [],
      false,
      async () => [],
      true,
    );

    const reconcile = fixture.reconciler.reconcileAndRestoreSuspended();
    await vi.waitFor(() => expect(fixture.releaseCreate).toBeDefined());
    const shutdown = fixture.reconciler.suspendForShutdown();
    expect(fixture.sessionKilled()).toBe(0);

    fixture.releaseCreate?.();
    await Promise.all([reconcile, shutdown]);

    expect(fixture.sessionKilled()).toBe(1);
    expect(fixture.windowExists()).toBe(false);
  });

  it("records suspension before killing the managed tmux session", async () => {
    const fixture = createFixture([launchEntry()], [], true);

    await fixture.reconciler.suspendForShutdown();

    expect(fixture.appended[0]).toMatchObject({
      customType: SUBAGENT_SUSPENDED_CUSTOM_TYPE,
      data: { writerSessionId: parentId, childSessionIds: [childId] },
    });
    expect(fixture.sessionKilled()).toBe(1);
  });

  it("accepts reconciliation again after the next session begins", async () => {
    const fixture = createFixture([launchEntry()], [], true);
    await fixture.reconciler.suspendForShutdown();

    fixture.reconciler.beginSession();
    await fixture.reconciler.reconcileAndRestoreSuspended();

    expect(fixture.created()).toBe(1);
  });

  it("never auto-restarts an interrupted child", async () => {
    const fixture = createFixture([launchEntry()], []);

    await fixture.reconciler.reconcileAndRestoreSuspended();

    expect(fixture.created()).toBe(0);
  });

  it("kills a stamped window whose launch was rewound away", async () => {
    const fixture = createFixture([], [], true);

    await fixture.reconciler.reconcile();

    expect(fixture.killed()).toBe(1);
  });

  it("owns broker registration history for the current session epoch", async () => {
    let live = true;
    const fixture = createFixture([launchEntry()], [], false, async () => (live ? [childId] : []));

    const observed = await fixture.reconciler.reconcile();
    live = false;
    const remembered = await fixture.reconciler.reconcile();
    fixture.reconciler.beginSession();
    const reset = await fixture.reconciler.reconcile();

    expect(observed.registered).toContain(childId);
    expect(remembered.registered).toContain(childId);
    expect(reset.registered).not.toContain(childId);
  });

  it("coalesces concurrent triggers and performs one dirty follow-up", async () => {
    let release: (() => void) | undefined;
    let calls = 0;
    const fixture = createFixture([], [], false, async () => {
      calls += 1;
      if (calls === 1) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      return [];
    });

    const first = fixture.reconciler.reconcile();
    const second = fixture.reconciler.reconcile();
    expect(second).toBe(first);
    await vi.waitFor(() => expect(release).toBeDefined());
    release?.();
    await first;

    expect(calls).toBe(2);
  });

  it("writes one fork disownment message", async () => {
    const foreign = launchEntry("aaaaaaaa-1234-1234-1234-123456789abc");
    const fixture = createFixture([foreign, launchEntry()], []);

    await fixture.reconciler.reconcile();
    await fixture.reconciler.reconcile();

    expect(fixture.appended).toEqual([]);
    expect(
      fixture.sent.filter(
        (entry) => entry.message.customType === SUBAGENT_DISOWNED_MESSAGE_CUSTOM_TYPE,
      ),
    ).toHaveLength(1);
  });
});

function createFixture(
  parentEntries: SessionEntry[],
  childEntries: SessionEntry[],
  initialWindow = false,
  listSessions: () => Promise<string[]> = async () => [],
  blockCreate = false,
  killSucceeds = true,
  idle = true,
) {
  let windowExists = initialWindow;
  let created = 0;
  let killed = 0;
  let sessionKilled = 0;
  let releaseCreate: (() => void) | undefined;
  const appended: Array<{ customType: string; data: unknown }> = [];
  const sent: Array<{
    message: { customType: string; content: string; display: boolean; details: unknown };
    options?: { triggerTurn: true } | { deliverAs: "steer" };
  }> = [];
  const branch = [...parentEntries];
  const executor = {
    appendEntry: vi.fn((customType: string, data: unknown) => {
      appended.push({ customType, data });
      branch.push(customEntry(`append-${branch.length}`, customType, data));
    }),
    sendMessage: vi.fn(
      (
        message: { customType: string; content: string; display: boolean; details: unknown },
        options?: { triggerTurn: true } | { deliverAs: "steer" },
      ) => {
        sent.push({ message, ...(options ? { options } : {}) });
        branch.push({
          type: "custom_message",
          id: `message-${branch.length}`,
          parentId: null,
          timestamp: "2026-03-25T00:00:00.000Z",
          ...message,
        });
      },
    ),
    exec: vi.fn(async (_command: string, args: string[]) => {
      switch (args[0]) {
        case "list-windows":
          return windowExists
            ? { code: 0, stdout: `@1\tChild\t${childId}\n`, stderr: "" }
            : { code: 1, stdout: "", stderr: "can't find session" };
        case "has-session":
          return { code: windowExists ? 0 : 1, stdout: "", stderr: "" };
        case "new-session":
        case "new-window":
          if (blockCreate) {
            await new Promise<void>((resolve) => {
              releaseCreate = resolve;
            });
          }
          created += 1;
          windowExists = true;
          return { code: 0, stdout: "@1\n", stderr: "" };
        case "set-option":
          return { code: 0, stdout: "", stderr: "" };
        case "kill-window":
          killed += 1;
          if (killSucceeds) {
            windowExists = false;
          }
          return {
            code: killSucceeds ? 0 : 1,
            stdout: "",
            stderr: killSucceeds ? "" : "kill failed",
          };
        case "kill-session":
          sessionKilled += 1;
          windowExists = false;
          return { code: 0, stdout: "", stderr: "" };
        default:
          throw new Error(`Unexpected tmux command: ${args.join(" ")}`);
      }
    }),
  };
  const parent = { sessionId: parentId, epoch: 1, getBranch: () => branch, isIdle: () => idle };
  const reconciler = new SubagentReconciler({
    executor: executor as never,
    messaging: { listSessions: vi.fn(listSessions) },
    getParent: () => parent,
    isCurrent: (epoch) => epoch === 1,
    openSession: () => ({ getBranch: () => childEntries }),
  });
  return {
    reconciler,
    append: (customType: string, data: unknown) => executor.appendEntry(customType, data),
    appended,
    sent,
    created: () => created,
    killed: () => killed,
    sessionKilled: () => sessionKilled,
    windowExists: () => windowExists,
    get releaseCreate() {
      return releaseCreate;
    },
  };
}

function launchEntry(writerSessionId = parentId) {
  return customEntry("launch", SUBAGENT_LAUNCHED_CUSTOM_TYPE, {
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

function reportEntry() {
  return customEntry("report", SUBAGENT_REPORT_CUSTOM_TYPE, {
    reportId: "report-1",
    status: "done",
    summary: "Complete.",
  });
}

function customEntry(id: string, customType: string, data: unknown) {
  return {
    type: "custom" as const,
    id,
    parentId: null,
    timestamp: "2026-03-25T00:00:00.000Z",
    customType,
    data,
  };
}
