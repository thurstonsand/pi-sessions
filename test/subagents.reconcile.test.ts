import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
  SUBAGENT_DISOWNED_NOTICE_CUSTOM_TYPE,
  SUBAGENT_LAUNCHED_CUSTOM_TYPE,
  SUBAGENT_OWNERSHIP_CLOSED_CUSTOM_TYPE,
  SUBAGENT_REPORT_CUSTOM_TYPE,
  SUBAGENT_REPORT_RECEIVED_CUSTOM_TYPE,
  SUBAGENT_SUSPENDED_CUSTOM_TYPE,
} from "../extensions/subagents/ledger.ts";
import { SubagentReconciler } from "../extensions/subagents/reconcile.ts";

const parentId = "12345678-1234-1234-1234-123456789abc";
const childId = "87654321-1234-1234-1234-123456789abc";

describe("subagent reconciliation", () => {
  it("recovers a missed report and closes dormant ownership", async () => {
    const fixture = createFixture([launchEntry()], [reportEntry()]);

    await fixture.reconciler.reconcile();

    expect(fixture.appended.map((entry) => entry.customType)).toEqual([
      SUBAGENT_REPORT_RECEIVED_CUSTOM_TYPE,
      SUBAGENT_OWNERSHIP_CLOSED_CUSTOM_TYPE,
    ]);
    expect(fixture.appended[0]?.data).toMatchObject({
      childSessionId: childId,
      reportId: "report-1",
      provenance: "recovered",
    });
    expect(fixture.sent).toEqual([`[system] subagent ${childId.slice(0, 8)} has result available`]);
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

  it("writes one fork disownment notice", async () => {
    const foreign = launchEntry("aaaaaaaa-1234-1234-1234-123456789abc");
    const fixture = createFixture([foreign, launchEntry()], []);

    await fixture.reconciler.reconcile();
    await fixture.reconciler.reconcile();

    expect(
      fixture.appended.filter((entry) => entry.customType === SUBAGENT_DISOWNED_NOTICE_CUSTOM_TYPE),
    ).toHaveLength(1);
  });
});

function createFixture(
  parentEntries: SessionEntry[],
  childEntries: SessionEntry[],
  initialWindow = false,
  listSessions: () => Promise<string[]> = async () => [],
  blockCreate = false,
) {
  let windowExists = initialWindow;
  let created = 0;
  let killed = 0;
  let sessionKilled = 0;
  let releaseCreate: (() => void) | undefined;
  const appended: Array<{ customType: string; data: unknown }> = [];
  const sent: string[] = [];
  const branch = [...parentEntries];
  const executor = {
    appendEntry: vi.fn((customType: string, data: unknown) => {
      appended.push({ customType, data });
      branch.push(customEntry(`append-${branch.length}`, customType, data));
    }),
    sendMessage: vi.fn((message: { content: string }) => sent.push(message.content)),
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
          windowExists = false;
          return { code: 0, stdout: "", stderr: "" };
        case "kill-session":
          sessionKilled += 1;
          windowExists = false;
          return { code: 0, stdout: "", stderr: "" };
        default:
          throw new Error(`Unexpected tmux command: ${args.join(" ")}`);
      }
    }),
  };
  const parent = { sessionId: parentId, epoch: 1, getBranch: () => branch };
  const reconciler = new SubagentReconciler({
    executor: executor as never,
    messaging: { listSessions: vi.fn(listSessions) },
    getParent: () => parent,
    isCurrent: (epoch) => epoch === 1,
    openSession: () => ({ getBranch: () => childEntries }),
  });
  return {
    reconciler,
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
