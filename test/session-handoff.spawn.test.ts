import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createChildGeneratedHandoffBootstrap,
  createHandoffBootstrap,
  createHandoffSessionMetadata,
  HANDOFF_BOOTSTRAP_ENV,
  parseHandoffBootstrap,
} from "../extensions/session-handoff/metadata.ts";
import {
  buildPiResumeCommand,
  createHandoffSession,
  prepareHandoffLaunch,
} from "../extensions/session-handoff/spawn.ts";

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

  it("prepares a session and resume command from a bootstrap builder", () => {
    const sessionDir = mkdtempSync(join(tmpdir(), "pi-sessions-handoff-prepare-"));
    let seenSessionId: string | undefined;

    const prepared = prepareHandoffLaunch({
      cwd: "/tmp/project",
      sessionDir,
      parentSessionFile: "/tmp/project/parent.jsonl",
      title: "Implement autocomplete",
      model: "openai/gpt-5.4:medium",
      buildBootstrap: (sessionId) => {
        seenSessionId = sessionId;
        return createHandoffBootstrap(sessionId, createMetadata());
      },
    });

    expect(seenSessionId).toBe(prepared.sessionId);
    expect(prepared.resumeCommand).toContain(prepared.sessionId);
    expect(prepared.resumeCommand).toContain("--model");
    expect(prepared.resumeCommand).toContain("openai/gpt-5.4:medium");

    const bootstrapValue = prepared.resumeCommand.match(
      /PI_SESSIONS_HANDOFF_BOOTSTRAP='([^']+)'/,
    )?.[1];
    expect(bootstrapValue && parseHandoffBootstrap(bootstrapValue)).toMatchObject({
      sessionId: prepared.sessionId,
      title: "Implement autocomplete",
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

function createMetadata() {
  return createHandoffSessionMetadata(
    "Finish phase 1",
    "Implement autocomplete",
    "Approved handoff draft",
    "Implement autocomplete",
  );
}
