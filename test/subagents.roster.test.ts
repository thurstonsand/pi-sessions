import type { SessionEntry, SessionTreeNode } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { SUBAGENT_LAUNCHED_CUSTOM_TYPE } from "../extensions/subagents/ledger.ts";
import { TranscriptSubagentRoster } from "../extensions/subagents/roster.ts";

const parentId = "12345678-1234-1234-1234-123456789abc";
const activeChildId = "aaaaaaaa-1234-1234-1234-123456789abc";
const historyChildId = "bbbbbbbb-1234-1234-1234-123456789abc";
const grandchildId = "cccccccc-1234-1234-1234-123456789abc";

describe("subagent transcript roster", () => {
  it("separates active-branch ownership from all-branch history and recurses without a depth cap", async () => {
    const fixture = createFixture();

    const branch = await fixture.roster.resolve("branch");
    const tree = await fixture.roster.resolve("tree");

    expect(branch.entries.map((entry) => entry.sessionId)).toEqual([activeChildId]);
    expect(tree.entries).toMatchObject([
      {
        sessionId: historyChildId,
        ownerTitle: "Parent board session",
        ownerIsCurrentSession: true,
        depth: 1,
        onActiveBranch: false,
      },
      {
        sessionId: activeChildId,
        ownerTitle: "Parent board session",
        ownerIsCurrentSession: true,
        depth: 1,
        onActiveBranch: true,
      },
      {
        sessionId: grandchildId,
        ownerTitle: "Historical child session",
        ownerIsCurrentSession: false,
        depth: 2,
        onActiveBranch: true,
      },
    ]);
    expect(tree.total).toBe(3);
  });

  it("excludes fork-copied foreign launches and does not recurse through a mismatched child file", async () => {
    const fixture = createFixture({ mismatchedHistorySession: true, foreignLaunch: true });

    const tree = await fixture.roster.resolve("tree");

    expect(tree.entries.map((entry) => entry.sessionId)).toEqual([historyChildId, activeChildId]);
    expect(tree.entries.find((entry) => entry.sessionId === historyChildId)?.state).toBe("unknown");
    expect(tree.entries).not.toContainEqual(expect.objectContaining({ sessionId: grandchildId }));
  });

  it("uses the latest relaunch metadata and timestamp", async () => {
    const fixture = createFixture({ relaunchActive: true });

    const branch = await fixture.roster.resolve("branch");

    expect(branch.entries).toMatchObject([
      {
        sessionId: activeChildId,
        title: "Relaunched worker",
        resumeCommand: "resume-new",
        launchedAt: "2026-03-25T00:05:00.000Z",
      },
    ]);
  });

  it("treats stamped windows and broker-only processes as managed-live", async () => {
    const fixture = createFixture({
      windowChildId: activeChildId,
      liveSessionIds: [historyChildId],
      registeredSessionIds: [activeChildId],
    });

    const tree = await fixture.roster.resolve("tree");

    expect(tree.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionId: activeChildId,
          managedLive: true,
          state: "busy",
          tmuxWindowId: "@1",
          launchedAt: "2026-03-25T00:00:00.000Z",
          resumeCommand: "resume",
        }),
        expect.objectContaining({ sessionId: historyChildId, managedLive: true, state: "active" }),
        expect.objectContaining({ sessionId: grandchildId, managedLive: false }),
      ]),
    );
  });
});

function createFixture(options?: {
  mismatchedHistorySession?: boolean;
  foreignLaunch?: boolean;
  windowChildId?: string;
  liveSessionIds?: string[];
  registeredSessionIds?: string[];
  relaunchActive?: boolean;
}) {
  const root = customEntry("root", "fixture.root", undefined, null);
  const activeLaunch = launchEntry(
    "launch-active",
    parentId,
    activeChildId,
    "active.jsonl",
    1,
    root.id,
  );
  const activeRelaunch = options?.relaunchActive
    ? launchEntry(
        "launch-active-again",
        parentId,
        activeChildId,
        "active.jsonl",
        1,
        activeLaunch.id,
        {
          title: "Relaunched worker",
          resumeCommand: "resume-new",
          timestamp: "2026-03-25T00:05:00.000Z",
        },
      )
    : undefined;
  const activeTail = customEntry(
    "active-tail",
    "fixture.tail",
    undefined,
    activeRelaunch?.id ?? activeLaunch.id,
  );
  const historyLaunch = launchEntry(
    "launch-history",
    parentId,
    historyChildId,
    "history.jsonl",
    1,
    root.id,
  );
  const foreignLaunch = launchEntry(
    "launch-foreign",
    "dddddddd-1234-1234-1234-123456789abc",
    "eeeeeeee-1234-1234-1234-123456789abc",
    "foreign.jsonl",
    1,
    root.id,
  );
  const parentEntries = [
    root,
    activeLaunch,
    ...(activeRelaunch ? [activeRelaunch] : []),
    activeTail,
    historyLaunch,
    ...(options?.foreignLaunch ? [foreignLaunch] : []),
  ];
  const parent = fakeSession(parentId, parentEntries, activeTail.id, "Parent board session");

  const activeRoot = customEntry("active-root", "fixture.root", undefined, null);
  const active = fakeSession(activeChildId, [activeRoot], activeRoot.id, "Active child session");

  const historyRoot = customEntry("history-root", "fixture.root", undefined, null);
  const grandchildLaunch = launchEntry(
    "launch-grandchild",
    historyChildId,
    grandchildId,
    "grandchild.jsonl",
    2,
    historyRoot.id,
  );
  const history = fakeSession(
    options?.mismatchedHistorySession ? "mismatched-session" : historyChildId,
    [historyRoot, grandchildLaunch],
    grandchildLaunch.id,
    "Historical child session",
  );

  const grandchildRoot = customEntry("grandchild-root", "fixture.root", undefined, null);
  const grandchild = fakeSession(
    grandchildId,
    [grandchildRoot],
    grandchildRoot.id,
    "Grandchild session",
  );
  const sessions = new Map([
    ["active.jsonl", active],
    ["history.jsonl", history],
    ["grandchild.jsonl", grandchild],
  ]);

  const roster = new TranscriptSubagentRoster({
    executor: {
      exec: vi.fn(async (_command: string, args: string[]) => {
        if (args[0] !== "list-windows") {
          throw new Error(`Unexpected tmux command: ${args.join(" ")}`);
        }
        const childId = options?.windowChildId;
        return childId
          ? { code: 0, stdout: `@1\tChild\t${childId}\n`, stderr: "", killed: false }
          : { code: 1, stdout: "", stderr: "can't find session", killed: false };
      }),
    },
    messaging: { listSessions: vi.fn(async () => options?.liveSessionIds ?? []) },
    getParent: () => ({ ...parent, epoch: 1 }),
    reconcile: vi.fn(async () => ({
      states: new Map(),
      registered: new Set(options?.registeredSessionIds),
    })),
    openSession(path: string) {
      const session = sessions.get(path);
      if (!session) {
        throw new Error(`Missing fixture session: ${path}`);
      }
      return session;
    },
  });

  return { roster };
}

function fakeSession(
  sessionId: string,
  entries: SessionEntry[],
  leafId: string,
  sessionName: string,
) {
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  return {
    sessionId,
    getSessionName: () => sessionName,
    getBranch(fromId?: string) {
      const branch: SessionEntry[] = [];
      let current = byId.get(fromId ?? leafId);
      while (current) {
        branch.push(current);
        current = current.parentId ? byId.get(current.parentId) : undefined;
      }
      return branch.reverse();
    },
    getTree() {
      const nodes = new Map<string, SessionTreeNode>(
        entries.map((entry) => [entry.id, { entry, children: [] }]),
      );
      const roots: SessionTreeNode[] = [];
      for (const entry of entries) {
        const node = nodes.get(entry.id);
        if (!node) continue;
        const parent = entry.parentId ? nodes.get(entry.parentId) : undefined;
        if (parent) parent.children.push(node);
        else roots.push(node);
      }
      return roots;
    },
  };
}

function launchEntry(
  id: string,
  writerSessionId: string,
  childSessionId: string,
  childSessionFile: string,
  depth: number,
  parentId: string | null,
  options?: {
    title?: string;
    resumeCommand?: string;
    timestamp?: string;
  },
) {
  return customEntry(
    id,
    SUBAGENT_LAUNCHED_CUSTOM_TYPE,
    {
      writerSessionId,
      childSessionId,
      childSessionFile,
      title: options?.title ?? childSessionId,
      goal: "Work",
      requestResponse: true,
      cwd: "/repo",
      resumeCommand: options?.resumeCommand ?? "resume",
      depth,
    },
    parentId,
    options?.timestamp,
  );
}

function customEntry(
  id: string,
  customType: string,
  data: unknown,
  parentId: string | null,
  timestamp = "2026-03-25T00:00:00.000Z",
) {
  return {
    type: "custom" as const,
    id,
    parentId,
    timestamp,
    customType,
    data,
  };
}
