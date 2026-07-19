import { describe, expect, it, vi } from "vitest";
import { SUBAGENT_IDENTITY_CUSTOM_TYPE } from "../extensions/subagents/identity.ts";
import { createSubagentLaunchTarget } from "../extensions/subagents/launch-target.ts";
import { SUBAGENT_LAUNCHED_CUSTOM_TYPE } from "../extensions/subagents/ledger.ts";

const parentId = "12345678-1234-1234-1234-123456789abc";

describe("subagent launch target", () => {
  it("prewrites identity, records ownership, and then creates a stamped tmux window", async () => {
    const order: string[] = [];
    const appendEntry = vi.fn(() => order.push("ledger"));
    const exec = vi.fn(async (_command: string, args: string[]) => {
      order.push(args[0] ?? "exec");
      if (args[0] === "list-windows") {
        return { code: 1, stdout: "", stderr: "can't find session" };
      }
      if (args[0] === "has-session") {
        return { code: 1, stdout: "", stderr: "" };
      }
      if (args[0] === "new-session") {
        return { code: 0, stdout: "@4\n", stderr: "" };
      }
      return { code: 0, stdout: "", stderr: "" };
    });
    const target = createSubagentLaunchTarget(
      { appendEntry, exec } as never,
      { sessionId: parentId, depth: 0, epoch: 3 },
      (epoch) => epoch === 3,
    );
    const appendCustomEntry = vi.fn();

    target.prepareChild({
      manager: { appendCustomEntry } as never,
      childSessionId: "child-session",
      parentSessionId: parentId,
      parentSessionFile: "/tmp/parent.jsonl",
      requestResponse: true,
    });
    expect(appendCustomEntry).toHaveBeenCalledWith(SUBAGENT_IDENTITY_CUSTOM_TYPE, {
      childSessionId: "child-session",
      ownerSessionId: parentId,
      parentSessionFile: "/tmp/parent.jsonl",
      depth: 1,
      requestResponse: true,
    });

    await expect(
      target.launch({
        prepared: {
          sessionId: "child-session",
          sessionFile: "/tmp/child.jsonl",
          resumeCommand: "pi --session-id child-session",
        },
        parentSessionId: parentId,
        title: "Inspect target",
        goal: "Inspect it",
        requestResponse: true,
        model: "openai/gpt-5.4:high",
        cwd: "/repo",
      }),
    ).resolves.toEqual({ success: true, backend: "tmux" });

    expect(appendEntry).toHaveBeenCalledWith(
      SUBAGENT_LAUNCHED_CUSTOM_TYPE,
      expect.objectContaining({
        writerSessionId: parentId,
        childSessionId: "child-session",
        childSessionFile: "/tmp/child.jsonl",
        requestResponse: true,
        depth: 1,
      }),
    );
    expect(order.indexOf("ledger")).toBeLessThan(order.indexOf("list-windows"));
    expect(exec).toHaveBeenCalledWith(
      "tmux",
      ["set-option", "-w", "-t", "@4", "@pi_session_id", "child-session"],
      expect.anything(),
    );
  });

  it("rejects stale launch continuations before writing ownership", async () => {
    const appendEntry = vi.fn();
    const target = createSubagentLaunchTarget(
      { appendEntry, exec: vi.fn() } as never,
      { sessionId: parentId, depth: 0, epoch: 1 },
      () => false,
    );

    await expect(
      target.launch({
        prepared: { sessionId: "child", sessionFile: "/tmp/c", resumeCommand: "resume" },
        parentSessionId: parentId,
        title: "Child",
        goal: "Work",
        requestResponse: true,
        model: "openai/gpt-5.4",
        cwd: "/repo",
      }),
    ).rejects.toThrow("parent session changed");
    expect(appendEntry).not.toHaveBeenCalled();
  });
});
