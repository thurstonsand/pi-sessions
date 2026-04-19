import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
  createHandoffBootstrap,
  createHandoffSessionMetadata,
  HANDOFF_BOOTSTRAP_ENV,
  parseHandoffBootstrap,
} from "../extensions/session-handoff/metadata.js";
import {
  buildPiLaunchCommand,
  buildPiResumeCommand,
  createHandoffSession,
  launchSplitHandoffSession,
  validateSplitHandoffPrerequisites,
} from "../extensions/session-handoff/spawn.js";

describe("session handoff spawn helpers", () => {
  it("creates a header-only child session file with parent lineage", () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "pi-sessions-handoff-spawn-"));

    const created = createHandoffSession({
      cwd: "/tmp/project",
      sessionDir,
      parentSessionFile: "/tmp/project/parent.jsonl",
    });

    const lines = readFileSync(created.sessionFile, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);

    const header = JSON.parse(lines[0] ?? "{}");

    expect(created.sessionId).toBe(header.id);
    expect(header).toMatchObject({
      type: "session",
      cwd: "/tmp/project",
      parentSession: "/tmp/project/parent.jsonl",
    });
  });

  it("builds a resume command with the bootstrap env and full session id", () => {
    const bootstrap = createHandoffBootstrap("child-session-123", createMetadata());
    const resumeCommand = buildPiResumeCommand(
      "/tmp/sessions",
      "child-session-123",
      Buffer.from(JSON.stringify(bootstrap), "utf8").toString("base64"),
    );

    expect(resumeCommand).toContain(HANDOFF_BOOTSTRAP_ENV);
    expect(resumeCommand).toContain("child-session-123");
    expect(resumeCommand).toContain("--session-dir");
    expect(resumeCommand).toContain("--session");
  });

  it("builds a zsh launch command around the bootstrap-aware resume command", () => {
    const launchCommand = buildPiLaunchCommand(
      "/tmp/sessions",
      "child-session-123",
      "encoded-bootstrap",
    );

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

  it("fails split preflight when ghostty-nav is unavailable", async () => {
    const previousTermProgram = process.env.TERM_PROGRAM;
    process.env.TERM_PROGRAM = "ghostty";

    const pi = createPiApi({ code: 1, stderr: "not found" });
    const ctx = {
      cwd: "/tmp/project",
      sessionManager: {
        getSessionFile() {
          return "/tmp/project/current.jsonl";
        },
      },
    };

    await expect(validateSplitHandoffPrerequisites(pi as never, ctx as never)).resolves.toBe(
      "Split handoff requires ghostty-nav on your PATH.",
    );

    process.env.TERM_PROGRAM = previousTermProgram;
  });

  it("launches ghostty-nav with focus pinned to the original pane", async () => {
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
    });

    expect(result).toEqual({ success: true });
    expect(pi.exec).toHaveBeenCalledWith(
      "ghostty-nav",
      [
        "split",
        "right",
        "--cwd",
        "/tmp/project",
        "--command",
        expect.stringContaining(HANDOFF_BOOTSTRAP_ENV),
        "--focus",
        "original",
      ],
      { cwd: "/tmp/project", timeout: 15_000 },
    );

    const ghosttyArgs = (pi.exec as ReturnType<typeof vi.fn>).mock.calls[0]?.[1] as string[];
    const command = ghosttyArgs[5] ?? "";
    expect(command).toContain(HANDOFF_BOOTSTRAP_ENV);
    expect(command).toContain("child-session-123");
    expect(command).toContain("/tmp/sessions");
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
  );
}
