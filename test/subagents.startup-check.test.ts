import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildHandoffKickoffMessage,
  buildHandoffKickoffSource,
} from "../extensions/session-handoff/kickoff.ts";
import {
  createChildGeneratedHandoffBootstrap,
  HANDOFF_BOOTSTRAP_PENDING_CUSTOM_TYPE,
} from "../extensions/session-handoff/metadata.ts";
import type { SubagentLaunched } from "../extensions/subagents/ledger.ts";
import { checkWorkerStartup } from "../extensions/subagents/startup-check.ts";
import type { WorkerRuntime } from "../extensions/subagents/worker-runtime.ts";

afterEach(() => {
  vi.useRealTimers();
});

const launch: SubagentLaunched = {
  writerSessionId: "parent",
  childSessionId: "child",
  childSessionFile: "/tmp/child.jsonl",
  title: "Haiku",
  briefing: "Write a haiku",
  reportBack: true,
  model: "faux/faux-1",
  cwd: "/repo",
  resumeCommand: "pi --session-id child",
  depth: 1,
};

const bootstrap = {
  type: "custom",
  id: "bootstrap-1",
  parentId: null,
  timestamp: "2026-11-26T00:00:00.000Z",
  customType: HANDOFF_BOOTSTRAP_PENDING_CUSTOM_TYPE,
  data: createChildGeneratedHandoffBootstrap({
    sessionId: "child",
    briefing: "Write a haiku",
    title: "Haiku",
    parentSessionFile: "/tmp/parent.jsonl",
    sourceLeafId: "leaf",
    reportBack: true,
    bootstrapMode: "automatic",
    launch: "subagent",
    subagent: { childSessionId: "child", ownerSessionId: "parent", depth: 1, reportBack: true },
  }),
} as unknown as SessionEntry;

const kickoff = {
  type: "custom_message",
  id: "kickoff-1",
  parentId: "bootstrap-1",
  timestamp: "2026-11-26T00:00:01.000Z",
  ...buildHandoffKickoffMessage({
    prompt: "Write a haiku",
    title: "Haiku",
    source: buildHandoffKickoffSource({ sessionId: "parent" }),
    bootstrapEntryId: "bootstrap-1",
  }),
} as unknown as SessionEntry;

async function runCheck(options: { windows: string[]; branch: SessionEntry[]; current?: boolean }) {
  vi.useFakeTimers();
  const onExited = vi.fn();
  const list = vi.fn(async () =>
    options.windows.map((piSessionId) => ({ piSessionId, observeCommand: "" })),
  );
  checkWorkerStartup({
    runtime: { list } as unknown as WorkerRuntime,
    ownerSessionId: "parent",
    launch,
    isCurrent: () => options.current ?? true,
    readChildBranch: () => options.branch,
    onExited,
    onError: (error) => {
      throw error;
    },
  });
  expect(list).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(2_000);
  return { onExited, list };
}

describe("worker startup check", () => {
  it("tells the parent when the worker is gone and the child never kicked off", async () => {
    const { onExited } = await runCheck({ windows: [], branch: [bootstrap] });
    expect(onExited).toHaveBeenCalledWith(undefined);
  });

  it("stays quiet while the worker window is still there", async () => {
    const { onExited } = await runCheck({ windows: ["child"], branch: [bootstrap] });
    expect(onExited).not.toHaveBeenCalled();
  });

  it("stays quiet for a child that kicked off and already finished", async () => {
    const { onExited } = await runCheck({ windows: [], branch: [bootstrap, kickoff] });
    expect(onExited).not.toHaveBeenCalled();
  });

  it("skips the check once the parent session has changed", async () => {
    const { onExited, list } = await runCheck({ windows: [], branch: [bootstrap], current: false });
    expect(list).not.toHaveBeenCalled();
    expect(onExited).not.toHaveBeenCalled();
  });
});
