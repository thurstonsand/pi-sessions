import { describe, expect, it, vi } from "vitest";
import type { CancelSessionResult } from "../extensions/session-messaging/install.ts";
import { SubagentCancellationRouter } from "../extensions/subagents/cancel.ts";
import type { SubagentState } from "../extensions/subagents/classify.ts";
import {
  SUBAGENT_CANCELLED_CUSTOM_TYPE,
  SUBAGENT_LAUNCHED_CUSTOM_TYPE,
} from "../extensions/subagents/ledger.ts";

const parentId = "12345678-1234-1234-1234-123456789abc";
const childId = "87654321-1234-1234-1234-123456789abc";

const deliveredCancellation: CancelSessionResult = {
  kind: "transport",
  delivered: true,
  cancelId: "cancel-1",
  target: { sessionId: childId, sessionName: "Child" },
  relation: "child",
};

describe("subagent cancellation", () => {
  it("records owned intent before broker cancellation and reconciliation", async () => {
    const order: string[] = [];
    const fixture = createFixture({
      live: true,
      state: "stopped",
      order,
      cancelResult: deliveredCancellation,
    });

    await expect(fixture.router.cancelSession(childId)).resolves.toEqual({
      kind: "managed",
      accepted: true,
      cancelId: "cancel-1",
      target: { sessionId: childId, sessionName: "Child" },
      relation: "child",
      state: "stopped",
    });

    expect(order).toEqual(["intent", "presence", "cancel", "reconcile"]);
    expect(fixture.appendEntry).toHaveBeenCalledWith(SUBAGENT_CANCELLED_CUSTOM_TYPE, {
      writerSessionId: parentId,
      childSessionId: childId,
    });
  });

  it("does not fabricate a cancel id for a dormant child", async () => {
    const fixture = createFixture({ state: "stopped" });

    const result = await fixture.router.cancelSession(childId);

    expect(result).toEqual({
      kind: "managed",
      accepted: true,
      target: { sessionId: childId, sessionName: "Child" },
      state: "stopped",
    });
    expect(fixture.cancelSession).not.toHaveBeenCalled();
  });

  it("reports the reconciler's state without reclassifying it", async () => {
    const fixture = createFixture({
      live: true,
      state: "active",
      cancelResult: deliveredCancellation,
    });

    await expect(fixture.router.cancelSession(childId)).resolves.toMatchObject({
      kind: "managed",
      state: "active",
    });
  });

  it("falls through unchanged for a session the parent does not own", async () => {
    const fixture = createFixture({ owned: false, cancelResult: deliveredCancellation });

    await expect(fixture.router.cancelSession(childId)).resolves.toEqual(deliveredCancellation);

    expect(fixture.cancelSession).toHaveBeenCalledWith(childId);
    expect(fixture.appendEntry).not.toHaveBeenCalled();
    expect(fixture.reconcile).not.toHaveBeenCalled();
  });
});

function createFixture(options: {
  owned?: boolean;
  live?: boolean;
  state?: SubagentState;
  order?: string[];
  cancelResult?: CancelSessionResult;
}) {
  const order = options.order ?? [];
  const branch = options.owned === false ? [] : [launchEntry()];
  const appendEntry = vi.fn((customType: string) => {
    order.push(customType === SUBAGENT_CANCELLED_CUSTOM_TYPE ? "intent" : customType);
  });
  const cancelSession = vi.fn(async (): Promise<CancelSessionResult> => {
    order.push("cancel");
    return (
      options.cancelResult ?? {
        kind: "transport" as const,
        delivered: false as const,
        cancelId: "cancel-1",
        error: "No live session found.",
      }
    );
  });
  const listSessions = vi.fn(async () => {
    order.push("presence");
    return options.live ? [childId] : [];
  });
  const reconcile = vi.fn(async () => {
    order.push("reconcile");
    return {
      states: new Map([[childId, options.state ?? "unknown"]]),
      registered: new Set<string>(),
    };
  });
  const parent = { sessionId: parentId, epoch: 7, getBranch: () => branch };
  const router = new SubagentCancellationRouter(
    { appendEntry },
    { cancelSession, listSessions },
    { reconcile },
    () => parent as never,
    (epoch) => epoch === 7,
  );

  return { router, appendEntry, cancelSession, reconcile };
}

function launchEntry() {
  return {
    type: "custom" as const,
    id: "launch",
    parentId: null,
    timestamp: "2026-03-25T00:00:00.000Z",
    customType: SUBAGENT_LAUNCHED_CUSTOM_TYPE,
    data: {
      writerSessionId: parentId,
      childSessionId: childId,
      childSessionFile: "/tmp/child.jsonl",
      title: "Child",
      goal: "Work",
      requestResponse: true,
      cwd: "/repo",
      resumeCommand: "resume",
      depth: 1,
    },
  };
}
