import path from "node:path";
import { initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import type { TUI } from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createChildGeneratedHandoffBootstrap,
  HANDOFF_BOOTSTRAP_PENDING_CUSTOM_TYPE,
} from "../extensions/session-handoff/metadata.ts";
import {
  createSessionReachableTool,
  type ReachableSubagentEntry,
  type SessionReachableDeps,
} from "../extensions/session-messaging/pi/reachable-tool.ts";
import {
  initializeSchema,
  insertSession,
  openIndexDatabase,
  rebuildSessionLineageRelations,
  setMetadata,
} from "../extensions/shared/session-index/index.ts";
import { createTestFilesystem } from "./test-helpers.ts";

const testFs = createTestFilesystem("pi-sessions-reachable-");

beforeAll(() => {
  initTheme("dark");
});

afterEach(() => {
  testFs.cleanup();
});

describe("session_reachable tool", () => {
  it("lists live user sessions with relations and drops self and foreign subagents", async () => {
    const dbPath = createIndex((db) => {
      insertIndexedSession(db, { sessionId: "current-session", sessionName: "Current" });
      insertIndexedSession(db, {
        sessionId: "live-child",
        sessionName: "Live child",
        modifiedAt: "2026-03-22T00:30:00.000Z",
        parentSessionPath: "/tmp/current-session.jsonl",
        parentSessionId: "current-session",
        sessionOrigin: "handoff",
      });
      insertIndexedSession(db, {
        sessionId: "foreign-subagent",
        sessionName: "Someone else's worker",
        sessionOrigin: "subagent",
      });
      rebuildSessionLineageRelations(db);
    });

    const tool = createSessionReachableTool(
      createDeps(dbPath, {
        listSessions: async () => [
          "current-session",
          "live-child",
          "foreign-subagent",
          "unindexed-live",
        ],
        getRelationTo: (sessionId) => (sessionId === "live-child" ? "child" : undefined),
      }),
    );

    const result = await tool.execute("tool-1", {}, undefined, undefined, createToolContext());
    const details = result.details as {
      scope: string;
      sessions: Array<{ sessionId: string; state: string; relation?: string; title?: string }>;
    };

    expect(details.scope).toBe("user");
    expect(details.sessions).toEqual([
      expect.objectContaining({
        sessionId: "live-child",
        title: "Live child",
        state: "live",
        relation: "child",
      }),
      expect.objectContaining({ sessionId: "unindexed-live", state: "live" }),
    ]);
    expect(details.sessions[1]).not.toHaveProperty("title");
  });

  it("marks a live session that has not finished bootstrapping as starting", async () => {
    const root = testFs.createTempDir();
    const sessionId = "starting-live-session";
    const sessionPath = testFs.writeJsonlFile(root, "starting-live.jsonl", [
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
          goal: "Continue the mission",
          title: "Starting live",
          parentSessionFile: "/tmp/parent.jsonl",
          sourceLeafId: "parent-leaf",
          requestResponse: false,
          bootstrapMode: "automatic",
          launch: "deferred",
        }),
      },
    ]);
    const dbPath = createIndex((db) => {
      insertIndexedSession(db, { sessionId, sessionPath, sessionName: "Starting live" });
    });

    const tool = createSessionReachableTool(
      createDeps(dbPath, { listSessions: async () => [sessionId] }),
    );
    const result = await tool.execute("tool-1", {}, undefined, undefined, createToolContext());

    expect((result.details as { sessions: Array<{ state: string }> }).sessions).toEqual([
      expect.objectContaining({ sessionId, state: "starting" }),
    ]);
    expect(renderTool(tool, {}, result)).toContain("[starting]");
  });

  it("returns owned subagents from the roster without consulting the index", async () => {
    const dbPath = createIndex(() => {});
    const listSubagents = vi.fn(async () => [
      subagentEntry("owned-busy", { state: "busy", onActiveBranch: true }),
      subagentEntry("owned-abandoned", { state: "completed", onActiveBranch: false }),
    ]);
    const tool = createSessionReachableTool(createDeps(dbPath, { listSubagents }));

    const result = await tool.execute(
      "tool-1",
      { scope: "branch" },
      undefined,
      undefined,
      createToolContext(),
    );
    const details = result.details as {
      scope: string;
      sessions: Array<{ sessionId: string; state: string; depth: number; goal: string }>;
    };

    expect(listSubagents).toHaveBeenCalledWith("branch");
    expect(details.scope).toBe("branch");
    expect(details.sessions).toEqual([
      expect.objectContaining({
        kind: "subagent",
        sessionId: "owned-busy",
        state: "busy",
        depth: 1,
        goal: "Work the problem",
      }),
      expect.objectContaining({ sessionId: "owned-abandoned", onActiveBranch: false }),
    ]);

    const rendered = renderTool(tool, { scope: "branch" }, result);
    expect(rendered).toContain("scope: branch • 2 sessions");
    expect(rendered).toContain("[busy • depth 1]");
    expect(rendered).toContain("[completed • depth 1 • history]");
  });

  it("hides the scope parameter when subagents are inactive", () => {
    const dbPath = createIndex(() => {});
    const withSubagents = createSessionReachableTool(
      createDeps(dbPath, { listSubagents: async () => [] }),
    );
    const withoutSubagents = createSessionReachableTool(createDeps(dbPath));

    expect(Object.keys(schemaProperties(withSubagents.parameters))).toEqual(["scope"]);
    expect(Object.keys(schemaProperties(withoutSubagents.parameters))).toEqual([]);
  });

  it("rejects subagent scopes when subagents are inactive", async () => {
    const dbPath = createIndex(() => {});
    const tool = createSessionReachableTool(createDeps(dbPath));

    await expect(
      tool.execute("tool-1", { scope: "tree" }, undefined, undefined, createToolContext()),
    ).rejects.toThrow('session_reachable scope "tree" requires subagents to be active.');
  });

  it("reports a broker failure instead of returning an empty list", async () => {
    const dbPath = createIndex(() => {});
    const tool = createSessionReachableTool(
      createDeps(dbPath, {
        listSessions: async () => {
          throw new Error("socket closed");
        },
      }),
    );

    await expect(
      tool.execute("tool-1", {}, undefined, undefined, createToolContext()),
    ).rejects.toThrow("Session messaging is unavailable: socket closed");
  });
});

function schemaProperties(schema: unknown): Record<string, unknown> {
  return (schema as { properties: Record<string, unknown> }).properties;
}

function createIndex(seed: (db: ReturnType<typeof openIndexDatabase>) => void): string {
  const dir = testFs.createTempDir();
  const dbPath = path.join(dir, "index.sqlite");
  const db = openIndexDatabase(dbPath, { create: true });
  initializeSchema(db);
  setMetadata(db, "indexed_at", "2026-03-22T00:00:00.000Z");
  seed(db);
  db.close();
  return dbPath;
}

function insertIndexedSession(
  db: ReturnType<typeof openIndexDatabase>,
  session: {
    sessionId: string;
    sessionName: string;
    sessionPath?: string;
    modifiedAt?: string;
    parentSessionPath?: string;
    parentSessionId?: string;
    sessionOrigin?: "handoff" | "subagent";
  },
): void {
  insertSession(
    db,
    {
      sessionId: session.sessionId,
      sessionPath: session.sessionPath ?? `/tmp/${session.sessionId}.jsonl`,
      sessionName: session.sessionName,
      cwd: "/repo/app",
      repoRoots: ["/repo"],
      startedAt: "2026-03-22T00:00:00.000Z",
      modifiedAt: session.modifiedAt ?? "2026-03-22T00:10:00.000Z",
      messageCount: 1,
      entryCount: 1,
      ...(session.parentSessionPath ? { parentSessionPath: session.parentSessionPath } : {}),
      ...(session.parentSessionId ? { parentSessionId: session.parentSessionId } : {}),
      ...(session.sessionOrigin ? { sessionOrigin: session.sessionOrigin } : {}),
    },
    "full_reindex",
  );
}

function createDeps(
  indexPath: string,
  overrides: Partial<SessionReachableDeps> = {},
): SessionReachableDeps {
  return {
    indexPath,
    listSessions: async () => [],
    getRelationTo: () => undefined,
    ...overrides,
  };
}

function subagentEntry(
  sessionId: string,
  overrides: Partial<ReachableSubagentEntry>,
): ReachableSubagentEntry {
  return {
    sessionId,
    title: sessionId,
    goal: "Work the problem",
    cwd: "/repo/app",
    state: "busy",
    depth: 1,
    onActiveBranch: true,
    launchedAt: "2026-03-22T00:00:00.000Z",
    ownerSessionId: "current-session",
    ownerTitle: "Current session",
    ownerIsCurrentSession: true,
    resumeCommand: `pi --session-id '${sessionId}'`,
    ...overrides,
  };
}

function renderTool(
  tool: ReturnType<typeof createSessionReachableTool>,
  args: Record<string, unknown>,
  result: { content: unknown; details: unknown },
): string {
  const component = new ToolExecutionComponent(
    tool.name,
    "tool-1",
    args,
    undefined,
    tool,
    createFakeTui(),
    "/repo",
  );
  component.updateResult(
    { content: result.content, details: result.details, isError: false } as never,
    false,
  );
  component.setExpanded(true);
  return stripAnsi(component.render(120).join("\n"));
}

function createToolContext(sessionId = "current-session") {
  return {
    cwd: "/repo",
    sessionManager: {
      getSessionId: () => sessionId,
    },
  } as never;
}

function createFakeTui(): TUI {
  return {
    requestRender() {},
  } as unknown as TUI;
}
