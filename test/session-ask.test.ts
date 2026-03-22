import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import sessionAskExtension from "../extensions/session-ask.js";
import { createTestFilesystem } from "./test-helpers.js";

const { completeMock } = vi.hoisted(() => ({
  completeMock: vi.fn(),
}));

vi.mock("@mariozechner/pi-ai", async () => {
  const actual = await vi.importActual<object>("@mariozechner/pi-ai");
  return {
    ...actual,
    complete: completeMock,
  };
});

const testFs = createTestFilesystem("pi-sessions-ask-");

afterEach(() => {
  completeMock.mockReset();
  testFs.cleanup();
});

describe("session_ask tool", () => {
  it("requires a non-empty question", async () => {
    const tool = registerSessionAskTool();

    const result = await tool.execute(
      "tool-1",
      { sessionPath: "/tmp/example.jsonl", question: "   " },
      undefined,
      undefined,
      createToolContext(),
    );

    expect(result.details).toMatchObject({ error: true });
    expect((result.content[0] as { text: string }).text).toContain(
      "session_ask requires a non-empty question.",
    );
  });

  it("returns a friendly error for a missing session path", async () => {
    const tool = registerSessionAskTool();

    const result = await tool.execute(
      "tool-1",
      { sessionPath: "/tmp/does-not-exist.jsonl", question: "What happened?" },
      undefined,
      undefined,
      createToolContext(),
    );

    expect(result.details).toMatchObject({ error: true });
    expect((result.content[0] as { text: string }).text).toContain("Session file not found");
  });

  it("includes session metadata and question in updates and final output", async () => {
    const tool = registerSessionAskTool();
    const sessionPath = testFs.writeJsonlFile(testFs.createTempDir(), "session.jsonl", [
      {
        type: "session",
        id: "session-ask-1",
        timestamp: "2026-03-22T00:00:00.000Z",
        cwd: "/repo/app",
      },
      {
        type: "session_info",
        id: "info-1",
        parentId: null,
        timestamp: "2026-03-22T00:00:01.000Z",
        name: "Ask title",
      },
      {
        type: "message",
        id: "user-1",
        parentId: "info-1",
        timestamp: "2026-03-22T00:00:02.000Z",
        message: {
          role: "user",
          content: [{ type: "text", text: "What decisions were made?" }],
        },
      },
    ]);

    completeMock.mockResolvedValue({
      content: [{ type: "text", text: "Decisions were made carefully." }],
      stopReason: "stop",
    });

    const updates: Array<{ content: Array<{ type: string; text?: string }> }> = [];
    const result = await tool.execute(
      "tool-1",
      { sessionPath, question: "Summarize the decisions." },
      undefined,
      (update) => updates.push(update),
      createToolContext(),
    );

    expect(updates).toHaveLength(2);
    expect((updates[1]?.content[0] as { text: string }).text).toContain("session: session-ask-1");
    expect((updates[1]?.content[0] as { text: string }).text).toContain("title: Ask title");
    expect((updates[1]?.content[0] as { text: string }).text).toContain(
      "question: Summarize the decisions.",
    );

    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("session: session-ask-1");
    expect(text).toContain("title: Ask title");
    expect(text).toContain("question: Summarize the decisions.");
    expect(text).toContain("Decisions were made carefully.");
  });
});

function registerSessionAskTool() {
  let registeredTool: Parameters<ExtensionAPI["registerTool"]>[0] | undefined;

  sessionAskExtension({
    registerTool(tool: Parameters<ExtensionAPI["registerTool"]>[0]) {
      registeredTool = tool;
    },
  } as unknown as ExtensionAPI);

  if (!registeredTool) {
    throw new Error("session_ask tool was not registered");
  }

  return registeredTool;
}

function createToolContext() {
  return {
    model: { provider: "openai", id: "gpt-5.4" },
    modelRegistry: {
      async getApiKey() {
        return "test-key";
      },
    },
  } as never;
}
