import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildHandoffKickoffMessage } from "../extensions/session-handoff/kickoff.ts";
import {
  createHandoffBootstrap,
  createHandoffSessionMetadata,
  findPendingHandoffBootstrap,
  HANDOFF_BOOTSTRAP_PENDING_CUSTOM_TYPE,
} from "../extensions/session-handoff/metadata.ts";
import { buildPiResumeCommand, prepareHandoffLaunch } from "../extensions/session-handoff/spawn.ts";

describe("session handoff spawn helpers", () => {
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
      buildBootstrap: (sessionId) =>
        createHandoffBootstrap(sessionId, createMetadata(), createSource()),
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
        title: "Implement autocomplete",
        source: createSource(),
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
      buildBootstrap: (sessionId) =>
        createHandoffBootstrap(sessionId, createMetadata(), createSource()),
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
      buildBootstrap: (sessionId) =>
        createHandoffBootstrap(sessionId, createMetadata(), createSource()),
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
      data: createHandoffBootstrap("child-1", createMetadata(), createSource()),
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
      buildBootstrap: (sessionId) =>
        createHandoffBootstrap(sessionId, createMetadata(), createSource()),
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
        initialPrompt: "Approved handoff draft",
      },
    });
  });
});

function createMetadata() {
  return createHandoffSessionMetadata(
    "Finish phase 1",
    "Implement autocomplete",
    "Approved handoff draft",
    "Implement autocomplete",
  );
}

function createSource() {
  return { sessionId: "parent-session-1", sessionName: "Parent Session" };
}
