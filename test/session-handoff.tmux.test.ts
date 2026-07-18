import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveSplitLaunchBackend } from "../extensions/session-handoff/launch/resolution.ts";
import { createTmuxSplitLaunchBackend } from "../extensions/session-handoff/launch/tmux.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("tmux handoff launch", () => {
  it("takes precedence over Ghostty when TMUX is set", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    expect(
      resolveSplitLaunchBackend(createPiApi(), {
        getTerminalId: () => undefined,
        env: {
          TMUX: "/tmp/tmux-501/default,1,0",
          TERM_PROGRAM: "ghostty",
        },
      })?.name,
    ).toBe("tmux");
  });

  it("uses Ghostty outside tmux when available", () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
    const previous = process.env.TERM_PROGRAM;
    process.env.TERM_PROGRAM = "ghostty";
    try {
      expect(
        resolveSplitLaunchBackend(createPiApi(), {
          getTerminalId: () => undefined,
          env: { TERM_PROGRAM: "ghostty" },
        })?.name,
      ).toBe("Ghostty");
    } finally {
      if (previous === undefined) delete process.env.TERM_PROGRAM;
      else process.env.TERM_PROGRAM = previous;
    }
  });

  it.each([
    ["left", ["split-window", "-h", "-b"]],
    ["right", ["split-window", "-h"]],
    ["up", ["split-window", "-v", "-b"]],
    ["down", ["split-window", "-v"]],
  ] as const)("launches a detached %s split", async (direction, prefix) => {
    const pi = createPiApi();
    const backend = createTmuxSplitLaunchBackend(pi as never, direction);

    await expect(
      backend.launch({
        cwd: "/tmp/project with spaces",
        title: "Inspect worker",
        resumeCommand: "pi --session-id 'child-1'",
      }),
    ).resolves.toEqual({ success: true });

    expect(pi.exec).toHaveBeenCalledWith(
      "tmux",
      [...prefix, "-d", "-c", "/tmp/project with spaces", "pi --session-id 'child-1'"],
      { cwd: "/tmp/project with spaces", timeout: 15_000 },
    );
  });

  it("reports tmux failures", async () => {
    const pi = createPiApi({ code: 1, stderr: "no current client" });

    await expect(
      createTmuxSplitLaunchBackend(pi as never, "right").launch({
        cwd: "/tmp/project",
        title: "Worker",
        resumeCommand: "pi --session-id child-1",
      }),
    ).resolves.toEqual({
      success: false,
      error: "Failed to launch tmux split: no current client.",
    });
  });
});

function createPiApi(result?: { code: number; stderr: string }): ExtensionAPI {
  return {
    exec: vi.fn().mockResolvedValue({
      stdout: "",
      stderr: result?.stderr ?? "",
      code: result?.code ?? 0,
      killed: false,
    }),
  } as never;
}
