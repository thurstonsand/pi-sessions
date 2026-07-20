import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { findSubagentIdentity } from "../extensions/subagents/identity.ts";
import { SUBAGENT_LAUNCHED_CUSTOM_TYPE } from "../extensions/subagents/ledger.ts";
import { createTestFilesystem } from "./test-helpers.ts";

const testFs = createTestFilesystem("pi-sessions-subagent-identity-");
const parentId = "parent-session";
const childId = "child-original";

afterEach(() => testFs.cleanup());

describe("subagent identity", () => {
  it("derives the prepared child identity from its parent's launch ledger", () => {
    const { childPath } = writeSessions(childId);

    expect(findSubagentIdentity(SessionManager.open(childPath))).toEqual({
      childSessionId: childId,
      ownerSessionId: parentId,
      parentSessionFile: expect.stringContaining("parent.jsonl"),
      depth: 2,
      requestResponse: true,
    });
  });

  it("does not identify a fork that has no matching parent launch", () => {
    const { forkPath } = writeSessions(childId);

    expect(findSubagentIdentity(SessionManager.open(forkPath))).toBeUndefined();
  });

  it("treats a missing parent as an ordinary session", () => {
    const root = testFs.createTempDir();
    const childPath = testFs.writeJsonlFile(root, "child.jsonl", [
      {
        type: "session",
        id: childId,
        timestamp: "2026-03-25T00:00:00.000Z",
        cwd: "/repo",
        parentSession: join(root, "missing.jsonl"),
      },
    ]);

    expect(findSubagentIdentity(SessionManager.open(childPath))).toBeUndefined();
  });

  it("fails when the parent transcript is unreadable", () => {
    const root = testFs.createTempDir();
    const parentPath = join(root, "parent.jsonl");
    writeFileSync(parentPath, "not-json\n");
    const childPath = testFs.writeJsonlFile(root, "child.jsonl", [
      {
        type: "session",
        id: childId,
        timestamp: "2026-03-25T00:00:00.000Z",
        cwd: "/repo",
        parentSession: parentPath,
      },
    ]);

    expect(() => findSubagentIdentity(SessionManager.open(childPath))).toThrow(
      "not a valid pi session",
    );
  });
});

function writeSessions(launchedChildId: string): { childPath: string; forkPath: string } {
  const root = testFs.createTempDir();
  const parentPath = join(root, "parent.jsonl");
  const childPath = join(root, "child.jsonl");
  const forkPath = join(root, "fork.jsonl");

  testFs.writeJsonlFile(root, "parent.jsonl", [
    {
      type: "session",
      id: parentId,
      timestamp: "2026-03-25T00:00:00.000Z",
      cwd: "/repo",
    },
    {
      type: "custom",
      id: "launch",
      parentId: null,
      timestamp: "2026-03-25T00:00:01.000Z",
      customType: SUBAGENT_LAUNCHED_CUSTOM_TYPE,
      data: {
        writerSessionId: parentId,
        childSessionId: launchedChildId,
        childSessionFile: childPath,
        title: "Child",
        goal: "Work",
        requestResponse: true,
        cwd: "/repo",
        resumeCommand: "resume",
        depth: 2,
      },
    },
  ]);
  testFs.writeJsonlFile(root, "child.jsonl", [
    {
      type: "session",
      id: childId,
      timestamp: "2026-03-25T00:00:02.000Z",
      cwd: "/repo",
      parentSession: parentPath,
    },
  ]);
  testFs.writeJsonlFile(root, "fork.jsonl", [
    {
      type: "session",
      id: "fork-session",
      timestamp: "2026-03-25T00:00:03.000Z",
      cwd: "/repo",
      parentSession: parentPath,
    },
  ]);

  return { childPath, forkPath };
}
