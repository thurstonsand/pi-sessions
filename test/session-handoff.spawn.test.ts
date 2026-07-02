import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createChildGeneratedHandoffBootstrap,
  createHandoffBootstrap,
  createHandoffSessionMetadata,
  HANDOFF_BOOTSTRAP_ENV,
  parseHandoffBootstrap,
} from "../extensions/session-handoff/metadata.ts";
import {
  buildPiLaunchCommand,
  buildPiResumeCommand,
  createHandoffSession,
  getFocusedGhosttyTerminalId,
  launchSplitHandoffSession,
  validateSplitHandoffPrerequisites,
} from "../extensions/session-handoff/spawn.ts";

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.TERM_PROGRAM;
});

describe("session handoff spawn helpers", () => {
  it("creates a child session file with parent lineage and optional title", () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "pi-sessions-handoff-spawn-"));

    const created = createHandoffSession({
      cwd: "/tmp/project",
      sessionDir,
      parentSessionFile: "/tmp/project/parent.jsonl",
      title: "Implement autocomplete",
    });

    const lines = readFileSync(created.sessionFile, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);

    const header = JSON.parse(lines[0] ?? "{}");
    const sessionInfo = JSON.parse(lines[1] ?? "{}");

    expect(created.sessionId).toBe(header.id);
    expect(header).toMatchObject({
      type: "session",
      cwd: "/tmp/project",
      parentSession: "/tmp/project/parent.jsonl",
    });
    expect(sessionInfo).toMatchObject({
      type: "session_info",
      parentId: null,
      name: "Implement autocomplete",
    });
  });

  it("builds a resume command with the bootstrap env and full session id", () => {
    const bootstrap = createHandoffBootstrap("child-session-123", createMetadata());
    const resumeCommand = buildPiResumeCommand(
      "/tmp/sessions",
      "child-session-123",
      Buffer.from(JSON.stringify(bootstrap), "utf8").toString("base64"),
      "Implement autocomplete",
    );

    expect(resumeCommand).toContain(HANDOFF_BOOTSTRAP_ENV);
    expect(resumeCommand).toContain("child-session-123");
    expect(resumeCommand).toContain("--session-dir");
    expect(resumeCommand).toContain("--session-id");
    expect(resumeCommand).toContain("--name");
    expect(resumeCommand).toContain("Implement autocomplete");
  });

  it("adds an inherited model to resume commands", () => {
    const bootstrap = createHandoffBootstrap("child-session-123", createMetadata());
    const resumeCommand = buildPiResumeCommand(
      "/tmp/sessions",
      "child-session-123",
      Buffer.from(JSON.stringify(bootstrap), "utf8").toString("base64"),
      "Implement autocomplete",
      "openai/gpt-5.4:medium",
    );

    expect(resumeCommand).toContain("--model");
    expect(resumeCommand).toContain("openai/gpt-5.4:medium");
  });

  it("builds a zsh launch command around the bootstrap-aware resume command", () => {
    const launchCommand = buildPiLaunchCommand({
      sessionDir: "/tmp/sessions",
      sessionId: "child-session-123",
      bootstrapValue: "encoded-bootstrap",
      title: "Implement autocomplete",
    });

    expect(launchCommand).toContain(HANDOFF_BOOTSTRAP_ENV);
    expect(launchCommand).toContain("encoded-bootstrap");
    expect(launchCommand).toContain("exec /bin/zsh -il");
  });

  it("fails split preflight when the current session is not persisted", async () => {
    const pi = createPiApi();
    const ctx = {
      cwd: "/tmp/project",
      sessionManager: {
        getSessionFile() {
          return undefined;
        },
      },
    };

    await expect(validateSplitHandoffPrerequisites(pi as never, ctx as never)).resolves.toBe(
      "Split handoff requires a persisted current session.",
    );
  });

  it("fails split preflight outside macOS", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    process.env.TERM_PROGRAM = "ghostty";

    const pi = createPiApi();
    const ctx = {
      cwd: "/tmp/project",
      sessionManager: {
        getSessionFile() {
          return "/tmp/project/current.jsonl";
        },
      },
    };

    await expect(validateSplitHandoffPrerequisites(pi as never, ctx as never)).resolves.toBe(
      "Split handoff currently supports Ghostty on macOS only.",
    );
  });

  it("fails split preflight when not running inside Ghostty", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("darwin");

    const pi = createPiApi();
    const ctx = {
      cwd: "/tmp/project",
      sessionManager: {
        getSessionFile() {
          return "/tmp/project/current.jsonl";
        },
      },
    };

    await expect(validateSplitHandoffPrerequisites(pi as never, ctx as never)).resolves.toBe(
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

  it("launches Ghostty via osascript with focus pinned to the original pane", async () => {
    const pi = createPiApi({ code: 0 });
    const bootstrapValue = Buffer.from(
      JSON.stringify(createHandoffBootstrap("child-session-123", createMetadata())),
      "utf8",
    ).toString("base64");

    const result = await launchSplitHandoffSession(pi as never, {
      cwd: "/tmp/project",
      sessionDir: "/tmp/sessions",
      direction: "right",
      sessionId: "child-session-123",
      bootstrapValue,
      title: "Implement autocomplete",
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
    expect(appleScript).toContain("focus targetTerminal");
    expect(appleScript).toContain(HANDOFF_BOOTSTRAP_ENV);
    expect(appleScript).toContain("child-session-123");
    expect(appleScript).toContain("/tmp/sessions");
    expect(appleScript).toContain("Implement autocomplete");
  });

  it("can launch from a stored Ghostty terminal id with an inherited model", async () => {
    const pi = createPiApi({ code: 0 });

    await launchSplitHandoffSession(pi as never, {
      cwd: "/tmp/project",
      sessionDir: "/tmp/sessions",
      direction: "down",
      sessionId: "child-session-123",
      bootstrapValue: "encoded-bootstrap",
      title: "Implement autocomplete",
      terminalId: "terminal-123",
      model: "openai/gpt-5.4:medium",
    });

    const osascriptArgs = (pi.exec as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string[];
    const appleScript = osascriptArgs[1] ?? "";
    expect(appleScript).toContain('every terminal whose id is "terminal-123"');
    expect(appleScript).toContain("split targetTerminal direction down with configuration cfg");
    expect(appleScript).toContain("--model");
    expect(appleScript).toContain("openai/gpt-5.4:medium");
    expect(appleScript).toContain("focus targetTerminal");
  });

  it("reports AppleScript launch failures with a macOS Ghostty hint", async () => {
    const pi = createPiApi({ code: 1, stderr: "execution error: Ghostty got an error" });

    const result = await launchSplitHandoffSession(pi as never, {
      cwd: "/tmp/project",
      sessionDir: "/tmp/sessions",
      direction: "right",
      sessionId: "child-session-123",
      bootstrapValue: "encoded-bootstrap",
      title: "Implement autocomplete",
    });

    expect(result).toEqual({
      success: false,
      error:
        "Failed to launch Ghostty split: execution error: Ghostty got an error. " +
        "Split handoff currently supports Ghostty on macOS only.",
    });
  });

  it("keeps child-generated bootstrap payloads decodable", () => {
    const bootstrapValue = Buffer.from(
      JSON.stringify(
        createChildGeneratedHandoffBootstrap({
          sessionId: "child-session-123",
          goal: "Finish phase 1",
          title: "Session handoff",
          parentSessionFile: "/tmp/parent.jsonl",
        }),
      ),
      "utf8",
    ).toString("base64");

    expect(parseHandoffBootstrap(bootstrapValue)).toEqual({
      mode: "generate",
      sessionId: "child-session-123",
      goal: "Finish phase 1",
      title: "Session handoff",
      parentSessionFile: "/tmp/parent.jsonl",
    });
  });

  it("keeps bootstrap payloads decodable after encoding", () => {
    const bootstrapValue = Buffer.from(
      JSON.stringify(createHandoffBootstrap("child-session-123", createMetadata())),
      "utf8",
    ).toString("base64");

    expect(parseHandoffBootstrap(bootstrapValue)).toEqual({
      sessionId: "child-session-123",
      goal: "Finish phase 1",
      nextTask: "Implement autocomplete",
      title: "Implement autocomplete",
      initialPrompt: "Approved handoff draft",
    });
  });
});

function createPiApi(result?: { code?: number; stdout?: string; stderr?: string }): ExtensionAPI {
  return {
    on: vi.fn(),
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    registerShortcut: vi.fn(),
    registerFlag: vi.fn(),
    getFlag: vi.fn(),
    registerMessageRenderer: vi.fn(),
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

function createMetadata() {
  return createHandoffSessionMetadata(
    "Finish phase 1",
    "Implement autocomplete",
    "Approved handoff draft",
    "Implement autocomplete",
  );
}
