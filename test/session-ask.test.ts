import { writeFileSync } from "node:fs";
import path from "node:path";
import type { ExtensionAPI, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import sessionAskExtension from "../extensions/session-ask.js";
import {
  initializeSchema,
  insertSession,
  openIndexDatabase,
  setMetadata,
} from "../extensions/shared/session-index/index.js";
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
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

afterEach(() => {
  completeMock.mockReset();
  if (originalAgentDir === undefined) {
    delete process.env.PI_CODING_AGENT_DIR;
  } else {
    process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  }
  testFs.cleanup();
});

describe("session_ask tool", () => {
  it("requires a non-empty question", async () => {
    const tool = registerSessionAskTool();

    const result = await tool.execute(
      "tool-1",
      { session: "12345678-1234-1234-1234-123456789abc", question: "   " },
      undefined,
      undefined,
      createToolContext(testFs.createTempDir()),
    );

    expect(result.details).toMatchObject({ error: true });
    expect((result.content[0] as { text: string }).text).toContain(
      "session_ask requires a question.",
    );
  });

  it("rejects non-uuid session references", async () => {
    const tool = registerSessionAskTool();

    const result = await tool.execute(
      "tool-1",
      { session: "@handoff/12345678", question: "What happened?" },
      undefined,
      undefined,
      createToolContext(testFs.createTempDir()),
    );

    expect(result.details).toMatchObject({ error: true });
    expect((result.content[0] as { text: string }).text).toContain(
      "requires an exact session UUID",
    );
  });

  it("returns a friendly error for a missing indexed session id", async () => {
    const agentDir = testFs.createTempDir();
    const root = testFs.createTempDir();
    const indexDir = testFs.ensureDir(path.join(root, "index"));
    const dbPath = path.join(indexDir, "index.sqlite");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    configureIndexSettings(agentDir, indexDir);

    const db = openIndexDatabase(dbPath, { create: true });
    initializeSchema(db);
    setMetadata(db, "indexed_at", "2026-03-22T00:00:00.000Z");
    db.close();

    const tool = registerSessionAskTool();
    const result = await tool.execute(
      "tool-1",
      { session: "12345678-1234-1234-1234-123456789abc", question: "What happened?" },
      undefined,
      undefined,
      createToolContext(root),
    );

    expect(result.details).toMatchObject({ error: true });
    expect((result.content[0] as { text: string }).text).toContain("No indexed session found");
  });

  it("resolves an exact session id through the index", async () => {
    const agentDir = testFs.createTempDir();
    const root = testFs.createTempDir();
    const indexDir = testFs.ensureDir(path.join(root, "index"));
    const dbPath = path.join(indexDir, "index.sqlite");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    configureIndexSettings(agentDir, indexDir);

    const sessionId = "12345678-1234-1234-1234-123456789abc";
    const sessionPath = testFs.writeJsonlFile(root, "session.jsonl", [
      {
        type: "session",
        id: sessionId,
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
          content: [{ type: "text", text: "Raw id session" }],
        },
      },
    ]);

    const db = openIndexDatabase(dbPath, { create: true });
    initializeSchema(db);
    setMetadata(db, "indexed_at", "2026-03-22T00:00:00.000Z");
    insertSession(
      db,
      {
        sessionId,
        sessionPath,
        sessionName: "",
        cwd: "/repo/app",
        repoRoots: ["/repo"],
        startedAt: "2026-03-22T00:00:00.000Z",
        modifiedAt: "2026-03-22T00:00:01.000Z",
        messageCount: 1,
        entryCount: 1,
      },
      "full_reindex",
    );
    db.close();

    completeMock.mockResolvedValue({
      content: [{ type: "text", text: "Resolved by exact id." }],
      stopReason: "stop",
    });

    const tool = registerSessionAskTool();
    const result = await tool.execute(
      "tool-1",
      { session: sessionId, question: "What happened?" },
      undefined,
      undefined,
      createToolContext(root),
    );

    expect(result.details).toMatchObject({
      sessionId,
      sessionPath,
    });
    expect((result.content[0] as { text: string }).text).toContain("Resolved by exact id.");
  });

  it("includes session metadata and question in updates and final output", async () => {
    const agentDir = testFs.createTempDir();
    const root = testFs.createTempDir();
    const indexDir = testFs.ensureDir(path.join(root, "index"));
    const dbPath = path.join(indexDir, "index.sqlite");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    configureIndexSettings(agentDir, indexDir);

    const sessionId = "aaaaaaaa-1234-1234-1234-123456789abc";
    const sessionPath = testFs.writeJsonlFile(testFs.createTempDir(), "session.jsonl", [
      {
        type: "session",
        id: sessionId,
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

    const db = openIndexDatabase(dbPath, { create: true });
    initializeSchema(db);
    setMetadata(db, "indexed_at", "2026-03-22T00:00:00.000Z");
    insertSession(
      db,
      {
        sessionId,
        sessionPath,
        sessionName: "Ask title",
        cwd: "/repo/app",
        repoRoots: ["/repo"],
        startedAt: "2026-03-22T00:00:00.000Z",
        modifiedAt: "2026-03-22T00:00:02.000Z",
        messageCount: 1,
        entryCount: 2,
      },
      "full_reindex",
    );
    db.close();

    completeMock.mockResolvedValue({
      content: [{ type: "text", text: "Decisions were made carefully." }],
      stopReason: "stop",
    });

    const tool = registerSessionAskTool();
    const updates: Array<{ content: Array<{ type: string; text?: string }> }> = [];
    const result = await tool.execute(
      "tool-1",
      { session: sessionId, question: "Summarize the decisions." },
      undefined,
      (update) => updates.push(update),
      createToolContext(root),
    );

    expect(updates).toHaveLength(2);
    expect((updates[1]?.content[0] as { text: string }).text).toContain(`session: ${sessionId}`);
    expect((updates[1]?.content[0] as { text: string }).text).toContain("title: Ask title");
    expect((updates[1]?.content[0] as { text: string }).text).toContain(
      "question: Summarize the decisions.",
    );

    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain(`session: ${sessionId}`);
    expect(text).toContain("title: Ask title");
    expect(text).toContain("question: Summarize the decisions.");
    expect(text).toContain("Decisions were made carefully.");
  });
});

function registerSessionAskTool() {
  let registeredTool: ToolDefinition | undefined;

  sessionAskExtension({
    registerTool(tool: ToolDefinition) {
      registeredTool = tool;
    },
  } as unknown as ExtensionAPI);

  if (!registeredTool) {
    throw new Error("session_ask tool was not registered");
  }

  return registeredTool;
}

function configureIndexSettings(agentDir: string, dir: string): void {
  writeFileSync(
    path.join(agentDir, "settings.json"),
    `${JSON.stringify({ sessions: { index: { dir } } }, null, 2)}\n`,
  );
}

function createToolContext(cwd: string) {
  return {
    cwd,
    model: { provider: "openai", id: "gpt-5.4" },
    modelRegistry: {
      async getApiKeyAndHeaders() {
        return { ok: true, apiKey: "test-key", headers: undefined };
      },
    },
  } as never;
}
