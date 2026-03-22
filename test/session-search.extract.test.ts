import { afterEach, describe, expect, it } from "vitest";
import {
  extractSessionRecord,
  renderSessionTreeMarkdown,
} from "../extensions/session-search/extract.js";
import { createTestFilesystem } from "./test-helpers.js";

const testFs = createTestFilesystem("pi-sessions-extract-");

afterEach(() => {
  testFs.cleanup();
});

describe("extractSessionRecord", () => {
  it("extracts session metadata and searchable chunks", () => {
    const filePath = testFs.writeJsonlFile(testFs.createTempDir(), "session.jsonl", [
      {
        type: "session",
        id: "session-1",
        timestamp: "2026-03-20T00:00:00.000Z",
        cwd: "/repo/app",
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
      },
      {
        type: "compaction",
        id: "compact-1",
        parentId: "branch-1",
        timestamp: "2026-03-20T00:00:06.000Z",
        summary: "Compacted older context.",
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
        "tool_result",
        "branch_summary",
        "compaction_summary",
      ]),
    );
    expect(extracted?.chunks.some((chunk) => chunk.text.includes("hidden"))).toBe(false);
  });
});

describe("renderSessionTreeMarkdown", () => {
  it("renders a compact tree and merges assistant tool calls with tool results", () => {
    const filePath = testFs.writeJsonlFile(testFs.createTempDir(), "tree.jsonl", [
      {
        type: "session",
        id: "session-2",
        timestamp: "2026-03-21T00:00:00.000Z",
        cwd: "/repo/app",
      },
      {
        type: "message",
        id: "user-1",
        parentId: null,
        timestamp: "2026-03-21T00:00:01.000Z",
        message: {
          role: "user",
          content: [{ type: "text", text: "Start here" }],
        },
      },
      {
        type: "message",
        id: "assistant-1",
        parentId: "user-1",
        timestamp: "2026-03-21T00:00:02.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "Checking files" },
            {
              type: "toolCall",
              id: "call-1",
              name: "read",
              arguments: { path: "/repo/app/src/index.ts" },
            },
            {
              type: "toolCall",
              id: "call-2",
              name: "write",
              arguments: { path: "/repo/app/src/out.txt" },
            },
          ],
        },
      },
      {
        type: "message",
        id: "tool-result-1",
        parentId: "assistant-1",
        timestamp: "2026-03-21T00:00:02.500Z",
        message: {
          role: "toolResult",
          toolCallId: "call-1",
          content: [{ type: "text", text: "export const value = 1;" }],
        },
      },
      {
        type: "message",
        id: "tool-result-2",
        parentId: "tool-result-1",
        timestamp: "2026-03-21T00:00:02.750Z",
        message: {
          role: "toolResult",
          toolCallId: "call-1",
          content: [{ type: "text", text: "second chunk" }],
        },
      },
      {
        type: "message",
        id: "tool-result-3",
        parentId: "tool-result-2",
        timestamp: "2026-03-21T00:00:02.900Z",
        message: {
          role: "toolResult",
          toolCallId: "call-2",
          content: [
            {
              type: "text",
              text: `${"A".repeat(520)}WRITE_RESULT_TAIL`,
            },
          ],
        },
      },
      {
        type: "message",
        id: "assistant-2",
        parentId: "tool-result-3",
        timestamp: "2026-03-21T00:00:03.000Z",
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "First branch with extra explanation that should remain fully visible even when it gets fairly long because assistant text must not be truncated in the rendered session tree output.",
            },
          ],
        },
      },
      {
        type: "message",
        id: "assistant-3",
        parentId: "tool-result-3",
        timestamp: "2026-03-21T00:00:04.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Second branch" }],
        },
      },
    ]);

    const rendered = renderSessionTreeMarkdown(filePath);
    expect(rendered.sessionId).toBe("session-2");
    expect(rendered.markdown).toContain("## Session Tree");
    expect(rendered.markdown).toContain("User: Start here");
    expect(rendered.markdown).toContain("Assistant: Checking files");
    expect(rendered.markdown).toContain("Read /repo/app/src/index.ts");
    expect(rendered.markdown).toContain("Write /repo/app/src/out.txt");
    expect(rendered.markdown).toContain("```");
    expect(rendered.markdown).toContain("export const value = 1;");
    expect(rendered.markdown).toContain("second chunk");
    expect(rendered.markdown).toContain("WRITE_RESULT_TAIL");
    expect(rendered.markdown).toContain("branches:");
    expect(rendered.markdown).toContain(
      "Assistant: First branch with extra explanation that should remain fully visible even when it gets fairly long because assistant text must not be truncated in the rendered session tree output.",
    );
    expect(rendered.markdown).toContain("Assistant: Second branch");
    expect(rendered.markdown).not.toContain("2026-03-21T00:00:02.000Z");
    expect(rendered.markdown).not.toContain("toolResult");
  });

  it("does not truncate by default when maxChars is omitted", () => {
    const filePath = testFs.writeJsonlFile(testFs.createTempDir(), "uncapped.jsonl", [
      {
        type: "session",
        id: "session-3",
        timestamp: "2026-03-22T00:00:00.000Z",
        cwd: "/repo/app",
      },
      {
        type: "message",
        id: "user-1",
        parentId: null,
        timestamp: "2026-03-22T00:00:01.000Z",
        message: {
          role: "user",
          content: [{ type: "text", text: `${"U".repeat(2500)}TAIL_MARKER` }],
        },
      },
    ]);

    const rendered = renderSessionTreeMarkdown(filePath);
    expect(rendered.markdown).toContain("TAIL_MARKER");
    expect(rendered.markdown).not.toContain("[session tree truncated");
  });
});
