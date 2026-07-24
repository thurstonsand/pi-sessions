import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { consumePendingHandoffBootstrap } from "../extensions/session-handoff/bootstrap.ts";
import {
  createChildGeneratedHandoffBootstrap,
  HANDOFF_BOOTSTRAP_PENDING_CUSTOM_TYPE,
  HANDOFF_METADATA_CUSTOM_TYPE,
} from "../extensions/session-handoff/metadata.ts";
import { createFakeModelRuntime } from "./test-helpers.ts";

const { generateHandoffDraftMock } = vi.hoisted(() => ({
  generateHandoffDraftMock: vi.fn(),
}));

vi.mock("../extensions/session-handoff/extract.ts", () => ({
  generateHandoffDraftFromSessionManager: generateHandoffDraftMock,
}));

afterEach(() => {
  vi.restoreAllMocks();
  generateHandoffDraftMock.mockReset();
});

describe("session handoff bootstrap", () => {
  it("uses the configured extraction model and notifies the child of persisted runs", async () => {
    const sourceSessionManager = {
      getSessionId: () => "parent-session",
      getSessionName: () => "Parent",
    };
    vi.spyOn(SessionManager, "open").mockReturnValue(sourceSessionManager as never);
    generateHandoffDraftMock.mockResolvedValue({
      draft: "Generated handoff draft",
      context: { summary: "Relevant context.", relevantFiles: [], openQuestions: [] },
      sessionId: "parent-session",
      sessionPath: "/tmp/parent.jsonl",
      debugSessionPath: "/tmp/handoff-runs/extraction.jsonl",
    });

    const bootstrapEntry = {
      type: "custom",
      id: "bootstrap-1",
      parentId: null,
      timestamp: "2026-03-23T00:00:00.000Z",
      customType: HANDOFF_BOOTSTRAP_PENDING_CUSTOM_TYPE,
      data: createChildGeneratedHandoffBootstrap({
        sessionId: "child-session",
        goal: "Finish phase 1",
        title: "Finish phase 1",
        parentSessionFile: "/tmp/parent.jsonl",
        sourceLeafId: "source-leaf",
        requestResponse: false,
        bootstrapMode: "automatic",
        launch: "subagent",
        subagent: {
          childSessionId: "child-session",
          ownerSessionId: "owner-session",
          depth: 1,
          requestResponse: false,
        },
      }),
    };
    const notify = vi.fn();
    const ctx = {
      hasUI: true,
      cwd: "/tmp/project",
      modelRegistry: {},
      ui: {
        notify,
        custom: vi.fn(
          (
            factory: (
              tui: unknown,
              theme: unknown,
              keybindings: unknown,
              done: (value: unknown) => void,
            ) => unknown,
          ) =>
            new Promise((resolve) => {
              factory({}, {}, {}, resolve);
            }),
        ),
      },
      sessionManager: {
        getSessionId: () => "child-session",
        getBranch: () => [bootstrapEntry],
        getEntries: () => [bootstrapEntry],
      },
      shutdown: vi.fn(),
    };
    const pi = {
      appendEntry: vi.fn(),
      setSessionName: vi.fn(),
      sendMessage: vi.fn(),
    };
    const extractionModel = {
      provider: "openai-codex",
      id: "gpt-5.6-terra",
    };
    const modelRuntime = createFakeModelRuntime({ available: [extractionModel as never] });
    const getModelRuntime = vi.fn().mockResolvedValue(modelRuntime);
    const handoffSettings = {
      pickerShortcut: "alt+o" as const,
      model: "openai-codex/gpt-5.6-terra",
      thinkingLevel: "low" as const,
      persistRuns: true,
      deferred: { copyToClipboard: true },
    };

    await consumePendingHandoffBootstrap(
      pi as never,
      ctx as never,
      getModelRuntime,
      "medium",
      handoffSettings,
    );

    expect(generateHandoffDraftMock).toHaveBeenCalledWith({
      ctx,
      modelRuntime,
      sourceSessionManager,
      sourceLeafId: "source-leaf",
      goal: "Finish phase 1",
      settings: handoffSettings,
      destinationThinkingLevel: "medium",
      signal: expect.any(AbortSignal),
      requestResponse: false,
    });
    expect(notify).toHaveBeenCalledWith(
      "Handoff extraction session saved to /tmp/handoff-runs/extraction.jsonl",
      "info",
    );
    expect(pi.sendMessage).toHaveBeenCalledOnce();
    expect(pi.appendEntry).toHaveBeenCalledWith(
      HANDOFF_METADATA_CUSTOM_TYPE,
      expect.objectContaining({
        origin: "handoff",
        launch: "subagent",
      }),
    );
    const metadata = pi.appendEntry.mock.calls.find(
      ([customType]) => customType === HANDOFF_METADATA_CUSTOM_TYPE,
    )?.[1];
    expect(metadata).not.toHaveProperty("subagent");
  });
});
