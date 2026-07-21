import { describe, expect, it } from "vitest";
import {
  buildHandoffBoardView,
  type HandoffBoardSnapshot,
  type UserSessionEntry,
} from "../extensions/session-handoff/board-view-model.ts";
import type { SubagentRosterEntry } from "../extensions/subagents/roster.ts";

const directionalSession = {
  sessionId: "split-child",
  timestamp: "2026-03-25T12:19:59.000Z",
  runEvidence: {
    transcriptAvailable: true,
    hasStarted: false,
  },
  receipt: {
    sessionId: "split-child",
    title: "Split handoff",
    launch: "right" as const,
    childSessionFile: "/tmp/split-child.jsonl",
    resumeCommand: "pi --session-id split-child",
    model: "openai/gpt-5.6-sol:high",
    backend: "Ghostty",
    cwd: "/other/repo",
  },
};

function snapshot(overrides?: {
  subagents?: readonly SubagentRosterEntry[];
  userSessions?: readonly UserSessionEntry[];
  liveSessionIds?: ReadonlySet<string>;
  hasLiveSessionEvidence?: boolean;
}): HandoffBoardSnapshot {
  return {
    subagents: overrides?.subagents ?? [],
    userSessions: overrides?.userSessions ?? [],
    liveSessionIds: overrides?.liveSessionIds ?? new Set(),
    hasLiveSessionEvidence: overrides?.hasLiveSessionEvidence ?? true,
  };
}

describe("handoff board view model", () => {
  it("reports an unstarted directional launch as starting and offers recovery", () => {
    const view = buildHandoffBoardView(
      snapshot({ userSessions: [directionalSession] }),
      "user-sessions",
      0,
      { insideTmux: false },
    );

    expect(view.rows).toMatchObject([{ status: "starting" }]);
    expect(view.action?.resumeCommand).toBe("pi --session-id split-child");
  });

  it("offers recovery for broker-absent sessions even when transcript evidence is unavailable", () => {
    const entry = { ...directionalSession, runEvidence: undefined };
    const view = buildHandoffBoardView(snapshot({ userSessions: [entry] }), "user-sessions", 0, {
      insideTmux: false,
    });

    expect(view.rows).toMatchObject([{ status: "unknown" }]);
    expect(view.action?.resumeCommand).toBe("pi --session-id split-child");
  });

  it("marks broker-observed directional sessions live without offering recovery", () => {
    const view = buildHandoffBoardView(
      snapshot({
        userSessions: [directionalSession],
        liveSessionIds: new Set([directionalSession.sessionId]),
      }),
      "user-sessions",
      0,
      { insideTmux: false },
    );

    expect(view.rows).toMatchObject([{ status: "live" }]);
    expect(view.action).toBeUndefined();
  });

  it("offers the durable command for a deferred session with negative liveness evidence", () => {
    const deferred = {
      ...directionalSession,
      receipt: { ...directionalSession.receipt, launch: "deferred" as const },
    };
    const view = buildHandoffBoardView(snapshot({ userSessions: [deferred] }), "user-sessions", 0, {
      insideTmux: false,
    });

    expect(view.rows).toMatchObject([{ status: "ready" }]);
    expect(view.action?.resumeCommand).toBe("pi --session-id split-child");
  });

  it("marks a broker-absent started session closed while allowing recovery", () => {
    const entry = {
      ...directionalSession,
      runEvidence: { transcriptAvailable: true, hasStarted: true },
    };
    const view = buildHandoffBoardView(snapshot({ userSessions: [entry] }), "user-sessions", 0, {
      insideTmux: false,
    });

    expect(view.rows).toMatchObject([{ status: "closed" }]);
    expect(view.action?.resumeCommand).toBe("pi --session-id split-child");
  });

  it("withholds recovery when broker evidence is unavailable", () => {
    const entry = {
      ...directionalSession,
      runEvidence: { transcriptAvailable: true, hasStarted: true },
    };
    const view = buildHandoffBoardView(
      snapshot({ userSessions: [entry], hasLiveSessionEvidence: false }),
      "user-sessions",
      0,
      { insideTmux: false },
    );

    expect(view.rows).toMatchObject([{ status: "unknown" }]);
    expect(view.action).toBeUndefined();
  });

  it("uses the shared details prefix before subagent metadata", () => {
    const subagent: SubagentRosterEntry = {
      sessionId: "worker",
      sessionFile: "/tmp/worker.jsonl",
      ownerSessionId: "parent",
      ownerTitle: "Board refinement",
      ownerIsCurrentSession: true,
      title: "Worker",
      goal: "Inspect the protocol",
      model: "openai/gpt-5.6-sol:high",
      cwd: "/repo",
      resumeCommand: "pi --session-id worker",
      launchedAt: "2026-03-25T12:00:00.000Z",
      depth: 1,
      state: "completed",
      onActiveBranch: true,
      managedLive: false,
    };
    const view = buildHandoffBoardView(snapshot({ subagents: [subagent] }), "subagents", 0, {
      insideTmux: false,
    });

    expect(view.details).toEqual([
      { label: "Session", value: "worker" },
      { label: "Model", value: "openai/gpt-5.6-sol:high" },
      { label: "Owner", value: "this session" },
      { label: "Goal", value: "Inspect the protocol" },
    ]);
  });

  it("uses the shared details prefix before user-session metadata", () => {
    const view = buildHandoffBoardView(
      snapshot({ userSessions: [directionalSession] }),
      "user-sessions",
      0,
      { insideTmux: false },
    );

    expect(view.details).toEqual([
      { label: "Session", value: "split-child" },
      { label: "Model", value: "openai/gpt-5.6-sol:high" },
      { label: "Launch", value: "right" },
      { label: "Backend", value: "Ghostty" },
      { label: "Directory", value: "/other/repo" },
    ]);
  });
});
