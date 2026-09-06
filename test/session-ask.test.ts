import { writeFileSync } from "node:fs";
import path from "node:path";
import type { ExtensionAPI, SessionEntry, ToolDefinition } from "@earendil-works/pi-coding-agent";
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
import {
  SUBAGENT_CANCELLED_CUSTOM_TYPE,
  SUBAGENT_CLOSED_CUSTOM_TYPE,
  SUBAGENT_LAUNCHED_CUSTOM_TYPE,
  SUBAGENT_REPORT_CUSTOM_TYPE,
} from "../extensions/subagents/ledger.ts";
import { shouldMessageSubagent } from "../extensions/subagents/should-message.ts";
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

describe("shouldMessageSubagent", () => {
  const parentId = "aaaaaaaa-1234-1234-1234-123456789abc";
  const childId = "bbbbbbbb-1234-1234-1234-123456789abc";
  const report = customEntry(SUBAGENT_REPORT_CUSTOM_TYPE, {
    reportId: "report-1",
    status: "done",
    summary: "Finished.",
  });
  const closure = customEntry(SUBAGENT_CLOSED_CUSTOM_TYPE, {
    reason: "no_response_expected",
  });

  it.each([
    { name: "reported and offline", branch: [report], window: false, live: false, expected: false },
    { name: "closed and offline", branch: [closure], window: false, live: false, expected: false },
    { name: "working in tmux", branch: [], window: true, live: false, expected: true },
    { name: "broker live", branch: [], window: false, live: true, expected: true },
    {
      name: "reported then woken in tmux",
      branch: [report],
      window: true,
      live: false,
      expected: true,
    },
    {
      name: "reported then broker live",
      branch: [report],
      window: false,
      live: true,
      expected: true,
    },
    { name: "interrupted but unfinished", branch: [], window: false, live: false, expected: true },
  ])("$name", async ({ branch, window, live, expected }) => {
    const deps = dependencies(branch, window, live);
    await expect(shouldMessageSubagent(childId, deps)).resolves.toBe(expected);
    expect(deps.openSession).toHaveBeenCalledWith("/child.jsonl");
    expect(deps.executor.exec).toHaveBeenCalledExactlyOnceWith(
      "tmux",
      [
        "list-windows",
        "-t",
        "pi-aaaaaaaa1234",
        "-F",
        "#{window_id}\t#{window_name}\t#{@pi_session_id}",
      ],
      { timeout: 15_000 },
    );
    expect(deps.messaging.listSessions).toHaveBeenCalledOnce();
  });

  it("does not redirect cancelled children even when live", async () => {
    const deps = dependencies([], true, true);
    deps
      .getParent()
      .getBranch()
      .push(
        customEntry(SUBAGENT_CANCELLED_CUSTOM_TYPE, {
          writerSessionId: parentId,
          childSessionId: childId,
        }),
      );
    await expect(shouldMessageSubagent(childId, deps)).resolves.toBe(false);
    expect(deps.openSession).not.toHaveBeenCalled();
    expect(deps.executor.exec).not.toHaveBeenCalled();
    expect(deps.messaging.listSessions).not.toHaveBeenCalled();
  });

  it("does not redirect children absent from the active branch", async () => {
    const deps = dependencies([], false, false);
    deps.getParent().getBranch().length = 0;
    await expect(shouldMessageSubagent(childId, deps)).resolves.toBe(false);
    expect(deps.openSession).not.toHaveBeenCalled();
  });

  it("keeps unreadable children unfinished", async () => {
    const deps = dependencies([], false, false);
    deps.openSession.mockImplementation(() => {
      throw new Error("unreadable");
    });
    await expect(shouldMessageSubagent(childId, deps)).resolves.toBe(true);
  });

  function dependencies(branch: SessionEntry[], window: boolean, live: boolean) {
    const parentBranch = [
      customEntry(SUBAGENT_LAUNCHED_CUSTOM_TYPE, {
        writerSessionId: parentId,
        childSessionId: childId,
        childSessionFile: "/child.jsonl",
        title: "Child",
        goal: "Work",
        requestResponse: true,
        cwd: "/repo",
        resumeCommand: "pi --session /child.jsonl",
        depth: 1,
      }),
    ];
    return {
      executor: {
        exec: vi.fn(async () => ({
          code: 0,
          stdout: window ? `@1\tchild\t${childId}\n` : "",
          stderr: "",
          killed: false,
        })),
      },
      messaging: { listSessions: vi.fn(async () => (live ? [childId] : [])) },
      getParent: () => ({ sessionId: parentId, getBranch: () => parentBranch }),
      openSession: vi.fn(() => ({ sessionId: childId, getBranch: () => branch })),
    };
  }

  function customEntry(customType: string, data: unknown): SessionEntry {
    return {
      type: "custom",
      id: customType,
      parentId: null,
      timestamp: "2026-03-22T00:00:00.000Z",
      customType,
      data,
    };
  }
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

  it("redirects to session_send_message when the target is your own subagent", async () => {
    const { root, sessionId } = indexPlainSession("cccccccc-1234-1234-1234-123456789abc");
    const shouldMessage = vi.fn(async () => true);

    const tool = registerSessionAskTool(shouldMessage);
    await expect(
      tool.execute(
        "tool-1",
        { session: sessionId, question: "What happened?" },
        undefined,
        undefined,
        createToolContext(root),
      ),
    ).rejects.toThrow(
      "That session is your unfinished subagent. Use session_send_message to ask it directly.",
    );

    expect(shouldMessage).toHaveBeenCalledWith(sessionId);
    expect(runSessionAskAgentMock).not.toHaveBeenCalled();
  });

  it("redirects for a just-launched subagent the index has never seen", async () => {
    const { root } = indexPlainSession("eeeeeeee-1234-1234-1234-123456789abc");
    const unindexedId = "ffffffff-1234-1234-1234-123456789abc";

    const tool = registerSessionAskTool(async (sessionId) => sessionId === unindexedId);
    await expect(
      tool.execute(
        "tool-1",
        { session: unindexedId, question: "What happened?" },
        undefined,
        undefined,
        createToolContext(root),
      ),
    ).rejects.toThrow(
      "That session is your unfinished subagent. Use session_send_message to ask it directly.",
    );
  });

  it("teaches the subagent rule only when subagents are wired in", () => {
    indexPlainSession("abababab-1234-1234-1234-123456789abc");

    expect(registerSessionAskTool(async () => false).promptGuidelines).toContain(
      "Use session_send_message for your unfinished subagents; session_ask can read completed subagent transcripts.",
    );
    expect(registerSessionAskTool().promptGuidelines).toEqual([
      "Use session_ask with focused questions rather than broad recap requests.",
    ]);
  });

  it.each(["not your subagent", "a completed subagent"])(
    "interrogates a session that is %s",
    async () => {
      const { root, sessionId } = indexPlainSession("dddddddd-1234-1234-1234-123456789abc");
      runSessionAskAgentMock.mockResolvedValue({
        answer: "Not a subagent.",
        relevantFiles: [],
      });

      const tool = registerSessionAskTool(async () => false);
      const result = await tool.execute(
        "tool-1",
        { session: sessionId, question: "What happened?" },
        undefined,
        undefined,
        createToolContext(root),
      );

      expect(runSessionAskAgentMock).toHaveBeenCalledOnce();
      expect((result.content[0] as { text: string }).text).toContain("Not a subagent.");
    },
  );

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

function registerSessionAskTool(shouldMessageSubagent?: (sessionId: string) => Promise<boolean>) {
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
      ...(shouldMessageSubagent ? { shouldMessageSubagent } : {}),
    },
  );

  if (!registeredTool) {
    throw new Error("session_ask tool was not registered");
  }

  return registeredTool;
}

function indexPlainSession(sessionId: string): { root: string; sessionId: string } {
  const agentDir = testFs.createTempDir();
  const root = testFs.createTempDir();
  const indexDir = testFs.ensureDir(path.join(root, "index"));
  const dbPath = path.join(indexDir, "index.sqlite");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  configureIndexSettings(agentDir, indexDir);

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
        content: [{ type: "text", text: "Delegated work" }],
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
      sessionName: "Delegated work",
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

  return { root, sessionId };
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
