import type { ExecResult } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
  createTmuxWindow,
  hasAttachedTmuxClients,
  isInsideTmux,
  killTmuxSession,
  killTmuxWindow,
  listTmuxWindows,
  type TmuxExecutor,
  tmuxSessionName,
} from "../extensions/shared/tmux.ts";

const ok = (stdout = ""): ExecResult => ({ stdout, stderr: "", code: 0, killed: false });
const missing = (): ExecResult => ({
  stdout: "",
  stderr: "can't find session: pi-deadbeef",
  code: 1,
  killed: false,
});

describe("tmux substrate", () => {
  it("detects tmux from its environment marker", () => {
    expect(isInsideTmux({ TMUX: "/tmp/tmux-501/default,1,0" })).toBe(true);
    expect(isInsideTmux({})).toBe(false);
  });

  it("derives stable per-parent session names", () => {
    expect(tmuxSessionName("88171ce4-9021-4464-8cab-f49d04a82815")).toBe("pi-88171ce49021");
    expect(() => tmuxSessionName("not-a-session-id")).toThrow(
      "Cannot derive tmux session name from session id",
    );
  });

  it("lists only stamped windows and treats a missing session as empty", async () => {
    const executor = fakeExecutor(
      ok("@1\tWorker one\tchild-1\n@2\tordinary shell\t\n@3\tWorker two\tchild-2\n"),
      missing(),
      {
        ...missing(),
        stderr: "error connecting to /tmp/private/tmux-501/default (No such file or directory)",
      },
    );

    await expect(listTmuxWindows(executor, "pi-deadbeef")).resolves.toEqual([
      { windowId: "@1", name: "Worker one", piSessionId: "child-1" },
      { windowId: "@3", name: "Worker two", piSessionId: "child-2" },
    ]);
    await expect(listTmuxWindows(executor, "pi-deadbeef")).resolves.toEqual([]);
    await expect(listTmuxWindows(executor, "pi-deadbeef")).resolves.toEqual([]);
  });

  it("detects attached clients for a managed tmux session", async () => {
    const executor = fakeExecutor(ok("/dev/ttys001\n"), ok());

    await expect(hasAttachedTmuxClients(executor, "pi-88171ce49021")).resolves.toBe(true);
    await expect(hasAttachedTmuxClients(executor, "pi-88171ce49021")).resolves.toBe(false);
    expect(executor.exec).toHaveBeenNthCalledWith(
      1,
      "tmux",
      ["list-clients", "-t", "pi-88171ce49021", "-F", "#{client_name}"],
      expect.anything(),
    );
  });

  it("creates and stamps the first window in a detached session", async () => {
    const executor = fakeExecutor(
      ok(),
      { ...missing(), stderr: "no server running" },
      ok("@7\n"),
      ok(),
    );

    await expect(
      createTmuxWindow(executor, {
        tmuxSession: "pi-88171ce49021",
        name: "Investigate race",
        cwd: "/tmp/project",
        command: "pi --session-id child-1",
        piSessionId: "child-1",
      }),
    ).resolves.toEqual({ windowId: "@7", name: "Investigate race", piSessionId: "child-1" });

    expect(executor.exec).toHaveBeenNthCalledWith(
      3,
      "tmux",
      [
        "new-session",
        "-d",
        "-P",
        "-F",
        "#{window_id}",
        "-s",
        "pi-88171ce49021",
        "-n",
        "Investigate race",
        "-c",
        "/tmp/project",
        "pi --session-id child-1",
      ],
      { cwd: "/tmp/project", timeout: 15_000 },
    );
    expect(executor.exec).toHaveBeenNthCalledWith(
      4,
      "tmux",
      ["set-option", "-w", "-t", "@7", "@pi_session_id", "child-1"],
      { timeout: 15_000 },
    );
  });

  it("returns an existing stamped window instead of spawning a duplicate", async () => {
    const executor = fakeExecutor(ok("@4\tExisting\tchild-1\n"));

    await expect(
      createTmuxWindow(executor, {
        tmuxSession: "pi-88171ce49021",
        name: "Replacement title",
        cwd: "/tmp/project",
        command: "pi --session-id child-1",
        piSessionId: "child-1",
      }),
    ).resolves.toEqual({ windowId: "@4", name: "Existing", piSessionId: "child-1" });
    expect(executor.exec).toHaveBeenCalledTimes(1);
  });

  it("verifies window and session teardown", async () => {
    const executor = fakeExecutor(ok("@4\tWorker\tchild-1\n"), ok(), missing(), ok(), missing());

    await expect(killTmuxWindow(executor, "pi-88171ce49021", "child-1")).resolves.toBe(true);
    await expect(killTmuxSession(executor, "pi-88171ce49021")).resolves.toBe(true);
    expect(executor.exec).toHaveBeenCalledWith("tmux", ["kill-window", "-t", "@4"], {
      timeout: 15_000,
    });
  });
});

function fakeExecutor(...results: ExecResult[]): TmuxExecutor & { exec: ReturnType<typeof vi.fn> } {
  return {
    exec: vi.fn(async () => results.shift() ?? ok()),
  };
}
