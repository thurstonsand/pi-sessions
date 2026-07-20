import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extractSessionRecord } from "../extensions/session-search/extract.ts";
import { createTestFilesystem } from "./test-helpers.ts";

const testFs = createTestFilesystem("pi-sessions-extract-");

afterEach(() => {
  testFs.cleanup();
});

describe("extractSessionRecord", () => {
  it("extracts session metadata, file touches, and repo roots", () => {
    const root = testFs.createTempDir();
    const repoRoot = testFs.ensureDir(path.join(root, "repo"));
    testFs.ensureDir(path.join(repoRoot, ".git"));
    const cwd = testFs.ensureDir(path.join(repoRoot, "app"));

    const filePath = testFs.writeJsonlFile(root, "session.jsonl", [
      {
        type: "session",
        id: "session-1",
        timestamp: "2026-03-20T00:00:00.000Z",
        cwd,
      },
      {
        type: "session_info",
        id: "info-1",
        parentId: null,
        timestamp: "2026-03-20T00:00:01.000Z",
        name: "Search sessions plan",
      },
      {
        type: "message",
        id: "user-1",
        parentId: "info-1",
        timestamp: "2026-03-20T00:00:02.000Z",
        message: {
          role: "user",
          content: [{ type: "text", text: "find session metadata" }],
          timestamp: Date.parse("2026-03-20T00:00:02.000Z"),
        },
      },
      {
        type: "message",
        id: "assistant-1",
        parentId: "user-1",
        timestamp: "2026-03-20T00:00:03.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "hidden" },
            { type: "text", text: "We should index this." },
            {
              type: "toolCall",
              id: "call-1",
              name: "read",
              arguments: { path: "src/index.ts" },
            },
            {
              type: "toolCall",
              id: "call-2",
              name: "write",
              arguments: { path: `${repoRoot}/generated/out.ts` },
            },
          ],
          timestamp: Date.parse("2026-03-20T00:00:03.000Z"),
        },
      },
      {
        type: "message",
        id: "tool-1",
        parentId: "assistant-1",
        timestamp: "2026-03-20T00:00:04.000Z",
        message: {
          role: "toolResult",
          content: [{ type: "text", text: "tool output goes here" }],
          timestamp: Date.parse("2026-03-20T00:00:04.000Z"),
        },
      },
      {
        type: "branch_summary",
        id: "branch-1",
        parentId: "assistant-1",
        timestamp: "2026-03-20T00:00:05.000Z",
        summary: "Abandoned branch discussed indexing strategy.",
        details: {
          readFiles: ["notes/plan.md"],
          modifiedFiles: ["src/index.ts"],
        },
      },
      {
        type: "compaction",
        id: "compact-1",
        parentId: "branch-1",
        timestamp: "2026-03-20T00:00:06.000Z",
        summary: "Compacted older context.",
        details: {
          readFiles: ["README.md"],
          modifiedFiles: ["generated/out.ts"],
        },
      },
    ]);

    const extracted = extractSessionRecord(filePath);
    expect(extracted).toBeDefined();
    expect(extracted?.sessionId).toBe("session-1");
    expect(extracted?.sessionName).toBe("Search sessions plan");
    expect(extracted?.messageCount).toBe(3);
    expect(extracted?.modifiedAt).toBe("2026-03-20T00:00:06.000Z");
    expect(extracted?.chunks.map((chunk) => chunk.sourceKind)).toEqual(
      expect.arrayContaining([
        "session_name",
        "user_text",
        "assistant_text",
        "tool_call",
        "tool_result",
        "branch_summary",
        "compaction_summary",
      ]),
    );
    expect(extracted?.chunks.some((chunk) => chunk.text.includes("hidden"))).toBe(false);
    expect(extracted?.chunks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          entryId: "assistant-1",
          sourceKind: "tool_call",
          text: expect.stringContaining("src/index.ts"),
        }),
      ]),
    );
    expect(extracted?.repoRoots).toEqual([repoRoot]);
    expect(extracted?.fileTouches).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          op: "read",
          source: "tool_call",
          rawPath: "src/index.ts",
          cwdRelPath: "src/index.ts",
          repoRelPath: "app/src/index.ts",
        }),
        expect.objectContaining({
          op: "changed",
          source: "tool_call",
          rawPath: `${repoRoot}/generated/out.ts`,
          absPath: `${repoRoot}/generated/out.ts`,
          repoRelPath: "generated/out.ts",
        }),
        expect.objectContaining({
          op: "changed",
          source: "branch_summary_details",
          rawPath: "src/index.ts",
        }),
        expect.objectContaining({
          op: "read",
          source: "compaction_details",
          rawPath: "README.md",
        }),
      ]),
    );
  });

  it("classifies a child with a matching parent launch as subagent origin", () => {
    const root = testFs.createTempDir();
    const parentPath = `${root}/parent.jsonl`;
    const childPath = `${root}/subagent.jsonl`;
    testFs.writeJsonlFile(root, "parent.jsonl", [
      {
        type: "session",
        id: "parent-session",
        timestamp: "2026-03-23T00:00:00.000Z",
        cwd: "/repo/app",
      },
      {
        type: "custom",
        id: "launch-1",
        parentId: null,
        timestamp: "2026-03-23T00:00:01.000Z",
        customType: "pi-sessions.subagent_launched",
        data: {
          writerSessionId: "parent-session",
          childSessionId: "subagent-session",
          childSessionFile: childPath,
          title: "Subagent",
          goal: "Investigate",
          requestResponse: true,
          cwd: "/repo/app",
          resumeCommand: "resume",
          depth: 1,
        },
      },
    ]);
    testFs.writeJsonlFile(root, "subagent.jsonl", [
      {
        type: "session",
        id: "subagent-session",
        timestamp: "2026-03-23T00:10:00.000Z",
        cwd: "/repo/app",
        parentSession: parentPath,
      },
    ]);

    expect(extractSessionRecord(childPath)).toMatchObject({
      sessionId: "subagent-session",
      sessionOrigin: "subagent",
    });
  });

  it("captures durable handoff metadata for child sessions", () => {
    const root = testFs.createTempDir();
    const parentPath = testFs.writeJsonlFile(root, "parent.jsonl", [
      {
        type: "session",
        id: "parent-session",
        timestamp: "2026-03-23T00:00:00.000Z",
        cwd: "/repo/app",
      },
    ]);
    const childPath = testFs.writeJsonlFile(root, "child.jsonl", [
      {
        type: "session",
        id: "child-session",
        timestamp: "2026-03-23T00:10:00.000Z",
        cwd: "/repo/app",
        parentSession: parentPath,
      },
      {
        type: "custom",
        id: "custom-1",
        parentId: null,
        timestamp: "2026-03-23T00:10:01.000Z",
        customType: "pi-sessions.handoff",
        data: {
          origin: "handoff",
          goal: "Continue phase 3",
          nextTask: "Implement autocomplete",
          title: "Implement autocomplete",
          initial_prompt: "Continue phase 3",
        },
      },
    ]);

    const extracted = extractSessionRecord(childPath);

    expect(extracted).toMatchObject({
      parentSessionPath: parentPath,
      parentSessionId: "parent-session",
      sessionOrigin: "handoff",
      handoffGoal: "Continue phase 3",
      handoffNextTask: "Implement autocomplete",
    });
  });
});
