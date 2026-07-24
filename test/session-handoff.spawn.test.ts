import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildHandoffKickoffMessage } from "../extensions/session-handoff/kickoff.ts";
import {
  createChildGeneratedHandoffBootstrap,
  findPendingHandoffBootstrap,
  HANDOFF_BOOTSTRAP_PENDING_CUSTOM_TYPE,
  isSessionStarting,
} from "../extensions/session-handoff/metadata.ts";
import {
  buildPiResumeCommand,
  formatHandoffLaunchFailure,
  prepareHandoffLaunch,
} from "../extensions/session-handoff/spawn.ts";

describe("session handoff spawn helpers", () => {
  it("formats one canonical recovery message for surviving prepared sessions", () => {
    expect(
      formatHandoffLaunchFailure("Backend failed.", {
        sessionId: "child-1",
        sessionFile: "/tmp/child-1.jsonl",
        resumeCommand: "pi --session-id child-1",
      }),
    ).toBe(
      "Backend failed. Created handoff session child-1; start it manually with: pi --session-id child-1",
    );
  });

  it("creates a prepared child session with lineage, title, and pending bootstrap", () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "pi-sessions-handoff-spawn-"));
    const cwd = mkdtempSync(join(tmpdir(), "pi-sessions-handoff-cwd-"));

    const prepared = prepareHandoffLaunch({
      targetCwd: cwd,
      parentCwd: cwd,
      parentSessionDir: sessionDir,
      parentSessionFile: "/tmp/project/parent.jsonl",
      title: "Implement autocomplete",
      model: undefined,
      buildBootstrap: (sessionId) => createBootstrap(sessionId),
    });

    const lines = readFileSync(prepared.sessionFile, "utf8").trim().split("\n");
    expect(lines).toHaveLength(3);

    const header = JSON.parse(lines[0] ?? "{}");
    const sessionInfo = JSON.parse(lines[1] ?? "{}");
    const bootstrapEntry = JSON.parse(lines[2] ?? "{}");

    expect(prepared.sessionId).toBe(header.id);
    expect(header).toMatchObject({
      type: "session",
      cwd,
      parentSession: "/tmp/project/parent.jsonl",
    });
    expect(sessionInfo).toMatchObject({
      type: "session_info",
      parentId: null,
      name: "Implement autocomplete",
    });
    expect(bootstrapEntry).toMatchObject({
      type: "custom",
      customType: HANDOFF_BOOTSTRAP_PENDING_CUSTOM_TYPE,
      parentId: sessionInfo.id,
      data: {
        sessionId: prepared.sessionId,
        mode: "generate",
        title: "Implement autocomplete",
        parentSessionFile: "/tmp/project/parent.jsonl",
        sourceLeafId: "source-leaf",
      },
    });
  });

  it("keeps same-cwd children in the parent session directory", () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "pi-sessions-handoff-dir-"));
    const cwd = mkdtempSync(join(tmpdir(), "pi-sessions-handoff-cwd-"));

    const prepared = prepareHandoffLaunch({
      targetCwd: cwd,
      parentCwd: cwd,
      parentSessionDir: sessionDir,
      parentSessionFile: "/tmp/parent.jsonl",
      title: "Title",
      model: undefined,
      buildBootstrap: (sessionId) => createBootstrap(sessionId),
    });

    expect(prepared.sessionFile.startsWith(sessionDir)).toBe(true);
    expect(prepared.resumeCommand).toContain("--session-dir");
    expect(prepared.resumeCommand).not.toContain("cd ");
  });

  it("gives cross-cwd children the target project default storage and a cd prefix", () => {
    const parentCwd = mkdtempSync(join(tmpdir(), "pi-sessions-handoff-parent-"));
    const targetCwd = mkdtempSync(join(tmpdir(), "pi-sessions-handoff-target-"));
    const parentSessionDir = mkdtempSync(join(tmpdir(), "pi-sessions-handoff-dir-"));
    const agentDir = mkdtempSync(join(tmpdir(), "pi-sessions-handoff-agent-"));
    const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;

    try {
      runCrossCwdAssertions(parentCwd, targetCwd, parentSessionDir, agentDir);
    } finally {
      if (originalAgentDir === undefined) {
        delete process.env.PI_CODING_AGENT_DIR;
      } else {
        process.env.PI_CODING_AGENT_DIR = originalAgentDir;
      }
    }
  });

  function runCrossCwdAssertions(
    parentCwd: string,
    targetCwd: string,
    parentSessionDir: string,
    agentDir: string,
  ) {
    const prepared = prepareHandoffLaunch({
      targetCwd,
      parentCwd,
      parentSessionDir,
      parentSessionFile: "/tmp/parent.jsonl",
      title: "Title",
      model: "openai/gpt-5.4:medium",
      buildBootstrap: (sessionId) => createBootstrap(sessionId),
    });

    expect(prepared.sessionFile.startsWith(parentSessionDir)).toBe(false);
    expect(prepared.sessionFile.startsWith(join(agentDir, "sessions"))).toBe(true);
    expect(prepared.resumeCommand.startsWith(`cd '${targetCwd}' && pi `)).toBe(true);
    expect(prepared.resumeCommand).not.toContain("--session-dir");
    expect(prepared.resumeCommand).toContain("--model");
    expect(prepared.resumeCommand).toContain("openai/gpt-5.4:medium");

    const header = JSON.parse(readFileSync(prepared.sessionFile, "utf8").split("\n")[0] ?? "{}");
    expect(header.cwd).toBe(targetCwd);
  }

  it("builds a plain resume command for default storage and matching cwds", () => {
    const resumeCommand = buildPiResumeCommand({
      targetCwd: "/repo/app",
      parentCwd: "/repo/app",
      sessionId: "child-session-123",
    });

    expect(resumeCommand).toBe("pi --session-id 'child-session-123'");
  });

  it("includes --session-dir only for nondefault directories", () => {
    const resumeCommand = buildPiResumeCommand({
      targetCwd: "/repo/app",
      parentCwd: "/repo/app",
      sessionId: "child-session-123",
      sessionDir: "/custom/sessions",
      model: "openai/gpt-5.4:medium",
    });

    expect(resumeCommand).toBe(
      "pi --session-dir '/custom/sessions' --session-id 'child-session-123' --model 'openai/gpt-5.4:medium'",
    );
  });

  it("only treats a kickoff for the same bootstrap as consumption", () => {
    const pending = {
      type: "custom",
      id: "bootstrap-1",
      customType: HANDOFF_BOOTSTRAP_PENDING_CUSTOM_TYPE,
      data: createBootstrap("child-1"),
    };
    const unrelatedKickoff = {
      type: "custom_message",
      id: "kickoff-1",
      ...buildHandoffKickoffMessage({
        prompt: "Other prompt",
        title: "Other handoff",
        source: createSource(),
        bootstrapEntryId: "bootstrap-2",
      }),
    };
    const matchingKickoff = {
      ...unrelatedKickoff,
      details: { ...unrelatedKickoff.details, bootstrapEntryId: "bootstrap-1" },
    };

    expect(findPendingHandoffBootstrap([pending, unrelatedKickoff] as never)).toMatchObject({
      kind: "pending",
      entryId: "bootstrap-1",
    });
    expect(findPendingHandoffBootstrap([pending, matchingKickoff] as never)).toBeUndefined();
  });

  it("reports a session as starting only while a well-formed bootstrap is pending", () => {
    const pending = {
      type: "custom",
      id: "bootstrap-1",
      customType: HANDOFF_BOOTSTRAP_PENDING_CUSTOM_TYPE,
      data: createBootstrap("child-1"),
    };
    const kickoff = {
      type: "custom_message",
      id: "kickoff-1",
      ...buildHandoffKickoffMessage({
        prompt: "Approved prompt",
        title: "Implement autocomplete",
        source: createSource(),
        bootstrapEntryId: "bootstrap-1",
      }),
    };
    const invalid = {
      type: "custom",
      id: "bootstrap-2",
      customType: HANDOFF_BOOTSTRAP_PENDING_CUSTOM_TYPE,
      data: { not: "a bootstrap" },
    };

    expect(isSessionStarting([pending] as never)).toBe(true);
    expect(isSessionStarting([pending, kickoff] as never)).toBe(false);
    expect(isSessionStarting([invalid] as never)).toBe(false);
    expect(isSessionStarting([] as never)).toBe(false);
  });

  it("round-trips the pending bootstrap through branch scanning", () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "pi-sessions-handoff-roundtrip-"));
    const cwd = mkdtempSync(join(tmpdir(), "pi-sessions-handoff-cwd-"));

    const prepared = prepareHandoffLaunch({
      targetCwd: cwd,
      parentCwd: cwd,
      parentSessionDir: sessionDir,
      parentSessionFile: "/tmp/parent.jsonl",
      title: "Implement autocomplete",
      model: undefined,
      buildBootstrap: (sessionId) => createBootstrap(sessionId),
    });

    const entries = readFileSync(prepared.sessionFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.type !== "session");

    const scan = findPendingHandoffBootstrap(entries as never);
    expect(scan).toMatchObject({
      kind: "pending",
      bootstrap: {
        sessionId: prepared.sessionId,
        goal: "Finish phase 1",
        parentSessionFile: "/tmp/project/parent.jsonl",
      },
    });
  });
});

function createBootstrap(sessionId: string) {
  return createChildGeneratedHandoffBootstrap({
    sessionId,
    goal: "Finish phase 1",
    title: "Implement autocomplete",
    parentSessionFile: "/tmp/project/parent.jsonl",
    sourceLeafId: "source-leaf",
    requestResponse: false,
    bootstrapMode: "review",
    launch: "right",
  });
}

function createSource() {
  return { sessionId: "parent-session-1", sessionName: "Parent Session" };
}
