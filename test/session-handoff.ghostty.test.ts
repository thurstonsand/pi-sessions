import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createGhosttyLaunchBackend,
  getFocusedGhosttyTerminalId,
  validateSplitHandoffPrerequisites,
} from "../extensions/session-handoff/launch/ghostty.ts";
import { HANDOFF_BOOTSTRAP_ENV } from "../extensions/session-handoff/metadata.ts";
import { buildPiResumeCommand } from "../extensions/session-handoff/spawn.ts";

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.TERM_PROGRAM;
});

describe("ghostty launch backend", () => {
  it("fails split preflight when the current session is not persisted", async () => {
    const ctx = {
      cwd: "/tmp/project",
      sessionManager: {
        getSessionFile() {
          return undefined;
        },
      },
    };

    await expect(validateSplitHandoffPrerequisites(ctx as never)).resolves.toBe(
      "Split handoff requires a persisted current session.",
    );
  });

  it("fails split preflight outside macOS", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    process.env.TERM_PROGRAM = "ghostty";

    const ctx = {
      cwd: "/tmp/project",
      sessionManager: {
        getSessionFile() {
          return "/tmp/project/current.jsonl";
        },
      },
    };

    await expect(validateSplitHandoffPrerequisites(ctx as never)).resolves.toBe(
      "Split handoff currently supports Ghostty on macOS only.",
    );
  });

  it("fails split preflight when not running inside Ghostty", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");

    const ctx = {
      cwd: "/tmp/project",
      sessionManager: {
        getSessionFile() {
          return "/tmp/project/current.jsonl";
        },
      },
    };

    await expect(validateSplitHandoffPrerequisites(ctx as never)).resolves.toBe(
      "Split handoff requires running inside Ghostty.",
    );
  });

  it("reads the focused Ghostty terminal id", async () => {
    const pi = createPiApi({ stdout: "terminal-123\n" });

    await expect(getFocusedGhosttyTerminalId(pi as never, "/tmp/project")).resolves.toBe(
      "terminal-123",
    );

    const osascriptArgs = (pi.exec as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string[];
    expect(osascriptArgs[1]).toContain("get id of focused terminal");
  });

  it("launches Ghostty via osascript without stealing focus", async () => {
    const pi = createPiApi({ code: 0 });
    const backend = createGhosttyLaunchBackend(pi as never, { direction: "right" });

    const result = await backend.launch({
      cwd: "/tmp/project",
      title: "Implement autocomplete",
      resumeCommand: resumeCommand("child-session-123"),
    });

    expect(result).toEqual({ success: true });
    expect(pi.exec).toHaveBeenCalledWith("/usr/bin/osascript", ["-e", expect.any(String)], {
      cwd: "/tmp/project",
      timeout: 15_000,
    });

    const osascriptArgs = (pi.exec as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string[];
    const appleScript = osascriptArgs[1] ?? "";
    expect(appleScript).toContain('tell application "Ghostty"');
    expect(appleScript).toContain("set cfg to new surface configuration");
    expect(appleScript).toContain('set initial working directory of cfg to "/tmp/project"');
    expect(appleScript).toContain("split targetTerminal direction right with configuration cfg");
    expect(appleScript).not.toContain("focus targetTerminal");
    expect(appleScript).toContain(HANDOFF_BOOTSTRAP_ENV);
    expect(appleScript).toContain("child-session-123");
  });

  it("can launch from a stored Ghostty terminal id with an inherited model", async () => {
    const pi = createPiApi({ code: 0 });
    const backend = createGhosttyLaunchBackend(pi as never, {
      direction: "down",
      terminalId: "terminal-123",
    });

    await backend.launch({
      cwd: "/tmp/project",
      title: "Implement autocomplete",
      resumeCommand: buildPiResumeCommand(
        "/tmp/sessions",
        "child-session-123",
        "encoded-bootstrap",
        "Implement autocomplete",
        "openai/gpt-5.4:medium",
      ),
    });

    const osascriptArgs = (pi.exec as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string[];
    const appleScript = osascriptArgs[1] ?? "";
    expect(appleScript).toContain('every terminal whose id is "terminal-123"');
    expect(appleScript).toContain("split targetTerminal direction down with configuration cfg");
    expect(appleScript).toContain("--model");
    expect(appleScript).toContain("openai/gpt-5.4:medium");
    expect(appleScript).not.toContain("focus targetTerminal");
  });

  it("falls back to the focused terminal when a stored id fails", async () => {
    const pi = createPiApi();
    (pi.exec as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ stdout: "", stderr: "no such terminal", code: 1, killed: false })
      .mockResolvedValueOnce({ stdout: "", stderr: "", code: 0, killed: false });
    const backend = createGhosttyLaunchBackend(pi as never, {
      direction: "right",
      terminalId: "terminal-123",
      fallbackToFocusedOnError: true,
    });

    const result = await backend.launch({
      cwd: "/tmp/project",
      title: "Implement autocomplete",
      resumeCommand: resumeCommand("child-session-123"),
    });

    expect(result).toEqual({ success: true });
    expect(pi.exec).toHaveBeenCalledTimes(2);
    const secondScript = (pi.exec as ReturnType<typeof vi.fn>).mock.calls[1]?.[1] as string[];
    expect(secondScript[1]).toContain("focused terminal of selected tab of front window");
  });

  it("reports AppleScript launch failures with a macOS Ghostty hint", async () => {
    const pi = createPiApi({ code: 1, stderr: "execution error: Ghostty got an error" });
    const backend = createGhosttyLaunchBackend(pi as never, { direction: "right" });

    const result = await backend.launch({
      cwd: "/tmp/project",
      title: "Implement autocomplete",
      resumeCommand: resumeCommand("child-session-123"),
    });

    expect(result).toEqual({
      success: false,
      error:
        "Failed to launch Ghostty split: execution error: Ghostty got an error. " +
        "Split handoff currently supports Ghostty on macOS only.",
    });
  });
});

function resumeCommand(sessionId: string): string {
  return buildPiResumeCommand(
    "/tmp/sessions",
    sessionId,
    "encoded-bootstrap",
    "Implement autocomplete",
  );
}

function createPiApi(result?: { code?: number; stdout?: string; stderr?: string }): ExtensionAPI {
  return {
    on: vi.fn(),
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    registerShortcut: vi.fn(),
    registerFlag: vi.fn(),
    getFlag: vi.fn(),
    registerMessageRenderer: vi.fn(),
    registerEntryRenderer: vi.fn(),
    sendMessage: vi.fn(),
    sendUserMessage: vi.fn(),
    appendEntry: vi.fn(),
    setSessionName: vi.fn(),
    getSessionName: vi.fn(),
    setLabel: vi.fn(),
    exec: vi.fn().mockResolvedValue({
      stdout: result?.stdout ?? "",
      stderr: result?.stderr ?? "",
      code: result?.code ?? 0,
      killed: false,
    }),
    getActiveTools: vi.fn(),
    getAllTools: vi.fn(),
    setActiveTools: vi.fn(),
    getCommands: vi.fn(),
    setModel: vi.fn(),
    getThinkingLevel: vi.fn(),
    setThinkingLevel: vi.fn(),
    registerProvider: vi.fn(),
    unregisterProvider: vi.fn(),
    events: {
      emit: vi.fn(),
      on: vi.fn().mockReturnValue(() => {}),
    },
  };
}
