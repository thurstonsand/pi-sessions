import { afterEach, describe, expect, it } from "vitest";
import {
  buildSessionMap,
  findBranchesForEntry,
  loadSessionNavigationData,
  readEntriesFromEntry,
} from "../extensions/session-ask/navigate.ts";
import { createTestFilesystem } from "./test-helpers.ts";

const testFs = createTestFilesystem("pi-sessions-ask-navigation-");

afterEach(() => {
  testFs.cleanup();
});

describe("session ask navigation", () => {
  it("reads forward on a selected branch from a shared trunk entry", () => {
    const root = testFs.createTempDir();
    const sessionPath = testFs.writeJsonlFile(root, "session.jsonl", [
      {
        type: "session",
        version: 3,
        id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        timestamp: "2026-03-22T00:00:00.000Z",
        cwd: root,
      },
      {
        type: "message",
        id: "user-1",
        parentId: null,
        timestamp: "2026-03-22T00:00:01.000Z",
        message: { role: "user", content: [{ type: "text", text: "Start" }] },
      },
      {
        type: "message",
        id: "assistant-a",
        parentId: "user-1",
        timestamp: "2026-03-22T00:00:02.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Branch A" }],
        },
      },
      {
        type: "message",
        id: "assistant-b",
        parentId: "user-1",
        timestamp: "2026-03-22T00:00:03.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Branch B" }],
        },
      },
    ]);

    const data = loadSessionNavigationData(sessionPath);
    const branches = findBranchesForEntry(data, "user-1");
    const readResult = readEntriesFromEntry(data, {
      entryId: "user-1",
      pathTargetEntryId: "assistant-a",
    });

    expect(branches.map((branch) => branch.branchLeafId).sort()).toEqual([
      "assistant-a",
      "assistant-b",
    ]);
    expect(readResult.entries.map((entry) => entry.entryId)).toEqual(["user-1", "assistant-a"]);
  });

  it("preserves conversational entries in previews and truncates tool-heavy entries", () => {
    const root = testFs.createTempDir();
    const longText = "target body ".repeat(300);
    const sessionPath = testFs.writeJsonlFile(root, "session.jsonl", [
      {
        type: "session",
        version: 3,
        id: "cccccccc-cccc-cccc-cccc-cccccccccccc",
        timestamp: "2026-03-22T00:00:00.000Z",
        cwd: root,
      },
      {
        type: "message",
        id: "long-user",
        parentId: null,
        timestamp: "2026-03-22T00:00:01.000Z",
        message: { role: "user", content: [{ type: "text", text: longText }] },
      },
      {
        type: "message",
        id: "long-tool-result",
        parentId: "long-user",
        timestamp: "2026-03-22T00:00:02.000Z",
        message: {
          role: "toolResult",
          content: [{ type: "text", text: longText }],
          toolCallId: "call-1",
          toolName: "read",
        },
      },
      {
        type: "message",
        id: "leaf",
        parentId: "long-tool-result",
        timestamp: "2026-03-22T00:00:03.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "Done" }] },
      },
    ]);

    const data = loadSessionNavigationData(sessionPath);
    const preview = readEntriesFromEntry(data, { entryId: "long-user", after: 1 });
    const full = readEntriesFromEntry(data, {
      entryId: "long-tool-result",
      after: 0,
      body: "full",
    });
    const userPreview = preview.entries.find((entry) => entry.entryId === "long-user");
    const toolPreview = preview.entries.find((entry) => entry.entryId === "long-tool-result");

    expect(userPreview?.body).toBe("preview");
    expect(userPreview?.truncated).toBe(false);
    expect(toolPreview?.body).toBe("preview");
    expect(toolPreview?.truncated).toBe(false);
    expect(toolPreview?.content).toContain("preview:");
    expect(toolPreview?.content.length).toBeLessThan(userPreview?.content.length ?? 0);
    expect(full.entries[0]?.body).toBe("full");
    expect(full.entries[0]?.truncated).toBe(false);
    expect(full.entries[0]?.content.length).toBeGreaterThan(toolPreview?.content.length ?? 0);
  });

  it("builds a session map from conversation spans", () => {
    const root = testFs.createTempDir();
    const sessionPath = testFs.writeJsonlFile(root, "session.jsonl", [
      {
        type: "session",
        version: 3,
        id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb",
        timestamp: "2026-03-22T00:00:00.000Z",
        cwd: root,
      },
      {
        type: "message",
        id: "root-user",
        parentId: null,
        timestamp: "2026-03-22T00:00:01.000Z",
        message: {
          role: "user",
          content: [{ type: "text", text: "Root prompt" }],
        },
      },
      {
        type: "message",
        id: "shared-assistant",
        parentId: "root-user",
        timestamp: "2026-03-22T00:00:02.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Shared answer" }],
        },
      },
      {
        type: "message",
        id: "branch-a-user",
        parentId: "shared-assistant",
        timestamp: "2026-03-22T00:00:03.000Z",
        message: {
          role: "user",
          content: [{ type: "text", text: "Branch A starts here" }],
        },
      },
      {
        type: "message",
        id: "branch-a-leaf",
        parentId: "branch-a-user",
        timestamp: "2026-03-22T00:00:04.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Branch A leaf" }],
        },
      },
      {
        type: "branch_summary",
        id: "branch-summary",
        parentId: "shared-assistant",
        timestamp: "2026-03-22T00:00:05.000Z",
        fromId: "shared-assistant",
        summary: "Abandoned branch A and started branch B.",
      },
      {
        type: "message",
        id: "branch-b-user",
        parentId: "branch-summary",
        timestamp: "2026-03-22T00:00:06.000Z",
        message: {
          role: "user",
          content: [{ type: "text", text: "Branch B starts here" }],
        },
      },
      {
        type: "compaction",
        id: "branch-b-compaction",
        parentId: "branch-b-user",
        timestamp: "2026-03-22T00:00:07.000Z",
        firstKeptEntryId: "branch-b-user",
        tokensBefore: 1000,
        summary: "Compacted branch B context.",
      },
      {
        type: "message",
        id: "branch-b-leaf",
        parentId: "branch-b-compaction",
        timestamp: "2026-03-22T00:00:08.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Branch B leaf" }],
        },
      },
    ]);

    const data = loadSessionNavigationData(sessionPath);
    const map = buildSessionMap(data);

    expect(data.branches.find((branch) => branch.leafId === "branch-a-leaf")?.label).toBe(
      "Branch A starts here",
    );
    expect(data.branches.find((branch) => branch.leafId === "branch-b-leaf")?.label).toBe(
      "Branch B starts here",
    );
    expect(map).toContain("### Conversation Spans");
    expect(map).toContain("#### Span (root-user, shared-assistant) (on_active_branch)");
    expect(map).toContain("- branches_to: branch-a-user | branch-summary");
    expect(map).toContain("#### Span (branch-a-user, branch-a-leaf)");
    expect(map).toContain("#### Span (branch-summary, branch-b-user) (on_active_branch)");
    expect(map).toContain("- branches_to: branch-b-compaction");
    expect(map).toContain("- branch_summary:");
    expect(map).toContain("  entry: branch-summary");
    expect(map).toContain("    Abandoned branch A and started branch B.");
    expect(map).toContain("#### Span (branch-b-compaction, branch-b-leaf) (on_active_branch)");
    expect(map).toContain("- compaction:");
    expect(map).toContain("  entry: branch-b-compaction");
    expect(map).toContain("    Compacted branch B context.");
    expect(map).not.toContain("entryId | type | timestamp | size | branch");

    expect(
      readEntriesFromEntry(data, {
        entryId: "branch-summary",
        pathTargetEntryId: "branch-b-user",
      }).entries.map((entry) => entry.entryId),
    ).toEqual(["branch-summary", "branch-b-user"]);
    expect(
      readEntriesFromEntry(data, {
        entryId: "branch-summary",
        after: 1,
      }).entries.map((entry) => entry.entryId),
    ).toEqual(["branch-summary", "branch-b-user"]);
    expect(
      readEntriesFromEntry(data, {
        entryId: "branch-a-user",
        after: 1,
      }).entries.map((entry) => entry.entryId),
    ).toEqual(["branch-a-user", "branch-a-leaf"]);
    expect(() => readEntriesFromEntry(data, { entryId: "branch-summary" })).toThrow(
      "requires before/after or pathTarget",
    );
    expect(() => readEntriesFromEntry(data, { entryId: "branch-summary", after: 2 })).toThrow(
      "crosses span boundary",
    );
  });
});
