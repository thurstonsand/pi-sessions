import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { consumePendingHandoffBootstrap } from "../extensions/session-handoff/bootstrap.ts";
import {
  createChildGeneratedHandoffBootstrap,
  HANDOFF_BOOTSTRAP_PENDING_CUSTOM_TYPE,
} from "../extensions/session-handoff/metadata.ts";

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
  it("passes persistence through extraction and notifies the child of the debug path", async () => {
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
    const getModelRuntime = vi.fn().mockResolvedValue({});

    await consumePendingHandoffBootstrap(
      pi as never,
      ctx as never,
      getModelRuntime,
      "medium",
      true,
    );

    expect(generateHandoffDraftMock).toHaveBeenCalledWith(
      ctx,
      {},
      sourceSessionManager,
      "source-leaf",
      "Finish phase 1",
      "medium",
      true,
      expect.any(AbortSignal),
      false,
    );
    expect(notify).toHaveBeenCalledWith(
      "Handoff extraction session saved to /tmp/handoff-runs/extraction.jsonl",
      "info",
    );
    expect(pi.sendMessage).toHaveBeenCalledOnce();
  });
});
