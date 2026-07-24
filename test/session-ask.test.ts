import { writeFileSync } from "node:fs";
import path from "node:path";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installAsk } from "../extensions/session-ask/install.ts";
import {
  createChildGeneratedHandoffBootstrap,
  HANDOFF_BOOTSTRAP_PENDING_CUSTOM_TYPE,
} from "../extensions/session-handoff/metadata.ts";
import {
  initializeSchema,
  insertSession,
  openIndexDatabase,
  setMetadata,
} from "../extensions/shared/session-index/index.ts";
import { loadSettings } from "../extensions/shared/settings.ts";
import { createTestFilesystem } from "./test-helpers.ts";

const { runSessionAskAgentMock } = vi.hoisted(() => ({
  runSessionAskAgentMock: vi.fn(),
}));

vi.mock("../extensions/session-ask/agent.ts", () => ({
  runSessionAskAgent: runSessionAskAgentMock,
}));

const testFs = createTestFilesystem("pi-sessions-ask-");
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;

afterEach(() => {
  runSessionAskAgentMock.mockReset();
  if (originalAgentDir === undefined) {
    delete process.env.PI_CODING_AGENT_DIR;
  } else {
    process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  }
  testFs.cleanup();
});

describe("session_ask tool", () => {
  it("limits collapsed answer previews by rendered terminal rows", () => {
    const tool = registerSessionAskTool();
    const component = tool.renderResult?.(
      {
        content: [{ type: "text", text: "answer" }],
        details: {
          answer: "A long answer ".repeat(80),
          question: "Q",
          relevantFiles: [],
          sessionId: "12345678-1234-1234-1234-123456789abc",
          sessionName: "Ask title",
          sessionPath: "/tmp/session.jsonl",
        },
      },
      { expanded: false, isPartial: false },
      {
        bold: (text: string) => text,
        fg: (_token: string, text: string) => text,
      } as never,
      { isError: false, state: {} } as never,
    );

    const rows = component?.render(40) ?? [];
    expect(rows.length).toBeGreaterThan(9);
    expect(rows.join("\n")).toContain("more lines");
    expect(rows.join("\n")).not.toContain("...");
  });

  it("requires a non-empty question", async () => {
    const tool = registerSessionAskTool();

    await expect(
      tool.execute(
        "tool-1",
        { session: "12345678-1234-1234-1234-123456789abc", question: "   " },
        undefined,
        undefined,
        createToolContext(testFs.createTempDir()),
      ),
    ).rejects.toThrow("session_ask requires a question.");
  });

  it("rejects non-uuid session references", async () => {
    const tool = registerSessionAskTool();

    await expect(
      tool.execute(
        "tool-1",
        { session: "@handoff/12345678", question: "What happened?" },
        undefined,
        undefined,
        createToolContext(testFs.createTempDir()),
      ),
    ).rejects.toThrow("requires an exact session UUID");
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
    await expect(
      tool.execute(
        "tool-1",
        { session: "12345678-1234-1234-1234-123456789abc", question: "What happened?" },
        undefined,
        undefined,
        createToolContext(root),
      ),
    ).rejects.toThrow("No indexed session found");
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

    runSessionAskAgentMock.mockResolvedValue({
      answer: "Resolved by exact id.",
      relevantFiles: [],
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

  it("returns before running the agent while the target session is starting", async () => {
    const agentDir = testFs.createTempDir();
    const root = testFs.createTempDir();
    const indexDir = testFs.ensureDir(path.join(root, "index"));
    const dbPath = path.join(indexDir, "index.sqlite");
    process.env.PI_CODING_AGENT_DIR = agentDir;
    configureIndexSettings(agentDir, indexDir);

    const sessionId = "bbbbbbbb-1234-1234-1234-123456789abc";
    const sessionPath = testFs.writeJsonlFile(root, "starting.jsonl", [
      {
        type: "session",
        id: sessionId,
        timestamp: "2026-03-22T00:00:00.000Z",
        cwd: "/repo/app",
      },
      {
        type: "custom",
        id: "bootstrap-1",
        parentId: null,
        timestamp: "2026-03-22T00:00:01.000Z",
        customType: HANDOFF_BOOTSTRAP_PENDING_CUSTOM_TYPE,
        data: createChildGeneratedHandoffBootstrap({
          sessionId,
          launch: "deferred",
          goal: "Continue the mission",
          title: "Starting child",
          parentSessionFile: "/tmp/parent.jsonl",
          sourceLeafId: "parent-leaf",
          requestResponse: true,
          bootstrapMode: "automatic",
        }),
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
        sessionName: "Starting child",
        cwd: "/repo/app",
        repoRoots: ["/repo"],
        startedAt: "2026-03-22T00:00:00.000Z",
        modifiedAt: "2026-03-22T00:00:01.000Z",
        messageCount: 0,
        entryCount: 1,
      },
      "full_reindex",
    );
    db.close();

    const tool = registerSessionAskTool();
    const result = await tool.execute(
      "tool-1",
      { session: sessionId, question: "What happened?" },
      undefined,
      undefined,
      createToolContext(root),
    );

    expect(runSessionAskAgentMock).not.toHaveBeenCalled();
    expect((result.content[0] as { text: string }).text).toContain("still starting");
    expect(result.details).toMatchObject({
      answer: expect.stringContaining("has not received its kickoff"),
      relevantFiles: [],
      sessionId,
      sessionPath,
      question: "What happened?",
    });
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

    runSessionAskAgentMock.mockResolvedValue({
      answer: "Decisions were made carefully.",
      relevantFiles: [],
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
    const finalUpdate = updates[1];
    if (!finalUpdate) {
      throw new Error("Expected final session_ask update.");
    }
    const updateText = finalUpdate.content[0]?.text;
    expect(updateText).toContain(`session: ${sessionId}`);
    expect(updateText).toContain("title: Ask title");
    expect(updateText).toContain("question: Summarize the decisions.");

    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain(`session: ${sessionId}`);
    expect(text).toContain("title: Ask title");
    expect(text).toContain("question: Summarize the decisions.");
    expect(text).toContain("Decisions were made carefully.");
  });
});

function registerSessionAskTool() {
  let registeredTool: ToolDefinition | undefined;

  const settings = loadSettings();
  installAsk(
    {
      registerTool(tool: ToolDefinition) {
        registeredTool = tool;
      },
      getThinkingLevel() {
        return "off";
      },
    } as unknown as ExtensionAPI,
    {
      settings,
      index: { path: settings.index.path },
      getModelRuntime: async () => ({}) as never,
    },
  );

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
