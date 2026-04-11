import { describe, expect, it } from "vitest";
import { createSessionAutoTitleController } from "../extensions/session-auto-title/controller.js";
import {
  AUTO_TITLE_STATE_CUSTOM_TYPE,
  type AutoTitlePersistedState,
  createAutoTitleState,
} from "../extensions/session-auto-title/state.js";

function createMessageEntry(
  id: string,
  parentId: string | null,
  role: "user" | "assistant",
  text: string,
  timestamp: number,
) {
  return {
    type: "message",
    id,
    parentId,
    timestamp: `2026-03-23T00:00:0${timestamp}.000Z`,
    message: {
      role,
      content: [{ type: "text", text }],
      timestamp,
    },
  };
}

function createCustomStateEntry(data: AutoTitlePersistedState) {
  return {
    type: "custom",
    id: "custom-state-1",
    parentId: "assistant-1",
    timestamp: "2026-03-23T00:00:03.000Z",
    customType: AUTO_TITLE_STATE_CUSTOM_TYPE,
    data,
  };
}

function createControllerContext(options?: {
  entries?: unknown[];
  leafId?: string | null;
  sessionFile?: string;
  sessionName?: string;
}) {
  const state = {
    entries: options?.entries ?? [],
    leafId: options?.leafId ?? null,
    sessionFile: options?.sessionFile ?? "/tmp/session.jsonl",
    sessionName: options?.sessionName,
  };

  return {
    state,
    ctx: {
      sessionManager: {
        getEntries() {
          return state.entries;
        },
        getLeafId() {
          return state.leafId;
        },
        getBranch() {
          return state.entries;
        },
        getSessionFile() {
          return state.sessionFile;
        },
        getSessionName() {
          return state.sessionName;
        },
      },
    } as never,
  };
}

describe("session auto-title controller", () => {
  it("triggers the initial title after the first completed user turn regardless of refreshTurns", () => {
    const controller = createSessionAutoTitleController({
      refreshTurns: 4,
      model: undefined,
    });
    const { state, ctx } = createControllerContext();

    state.entries = [
      createMessageEntry("user-1", null, "user", "Implement session auto-title", 1),
      createMessageEntry("assistant-1", "user-1", "assistant", "Working on it.", 2),
    ];
    state.leafId = "assistant-1";

    controller.handleSessionStart(ctx);
    const result = controller.handleTurnEnd(ctx);

    expect(result.persistedState).toBeUndefined();
    expect(result.plan).toEqual({
      reason: "initial",
      userTurnCount: 1,
      currentTitle: undefined,
    });
  });

  it("only triggers periodic retitling after the configured number of new user turns", () => {
    const controller = createSessionAutoTitleController({
      refreshTurns: 3,
      model: undefined,
    });
    const { state, ctx } = createControllerContext();

    state.entries = [
      createMessageEntry("user-1", null, "user", "First task", 1),
      createMessageEntry("assistant-1", "user-1", "assistant", "Done", 2),
    ];
    state.leafId = "assistant-1";
    controller.handleSessionStart(ctx);

    const initialResult = controller.handleTurnEnd(ctx);
    expect(initialResult.plan?.reason).toBe("initial");
    if (!initialResult.plan) {
      throw new Error("Expected initial title plan");
    }

    const persistedState = controller.handleTitleApplied("First task", initialResult.plan);
    expect(persistedState.lastAppliedUserTurnCount).toBe(1);
    state.sessionName = "First task";

    state.entries = [
      ...state.entries,
      createMessageEntry("user-2", "assistant-1", "user", "Second task", 3),
      createMessageEntry("assistant-2", "user-2", "assistant", "Done", 4),
      createMessageEntry("user-3", "assistant-2", "user", "Third task", 5),
      createMessageEntry("assistant-3", "user-3", "assistant", "Done", 6),
    ];
    state.leafId = "assistant-3";

    expect(controller.handleTurnEnd(ctx).plan).toBeUndefined();

    state.entries = [
      ...state.entries,
      createMessageEntry("user-4", "assistant-3", "user", "Fourth task", 7),
      createMessageEntry("assistant-4", "user-4", "assistant", "Done", 8),
    ];
    state.leafId = "assistant-4";

    const result = controller.handleTurnEnd(ctx);
    expect(result.plan).toEqual({
      reason: "periodic",
      userTurnCount: 4,
      currentTitle: "First task",
    });
  });

  it("does not trigger on sessions that already have a user title and no auto-title state", () => {
    const controller = createSessionAutoTitleController({
      refreshTurns: 2,
      model: undefined,
    });
    const { ctx } = createControllerContext({
      sessionName: "Investigate bug",
      entries: [
        createMessageEntry("user-1", null, "user", "Investigate bug", 1),
        createMessageEntry("assistant-1", "user-1", "assistant", "Investigating", 2),
      ],
      leafId: "assistant-1",
    });

    const persistedState = controller.handleSessionStart(ctx);

    expect(controller.getState().mode).toBe("paused_manual");
    expect(persistedState).toEqual(expect.objectContaining({ mode: "paused_manual" }));
    expect(controller.handleTurnEnd(ctx).plan).toBeUndefined();
  });

  it("pauses automation when the current session name diverges from the last auto title", () => {
    const controller = createSessionAutoTitleController({
      refreshTurns: 4,
      model: undefined,
    });
    const { ctx } = createControllerContext({
      sessionName: "Manual Title",
      entries: [
        createMessageEntry("user-1", null, "user", "Auto title me", 1),
        createMessageEntry("assistant-1", "user-1", "assistant", "Done", 2),
        createCustomStateEntry(
          createAutoTitleState({
            lastAutoTitle: "Generated Title",
            lastAppliedUserTurnCount: 1,
            lastTrigger: "initial",
          }),
        ),
      ],
      leafId: "custom-state-1",
    });

    const persistedState = controller.handleSessionStart(ctx);

    expect(controller.getState().mode).toBe("paused_manual");
    expect(persistedState).toEqual(
      expect.objectContaining({
        mode: "paused_manual",
        lastAutoTitle: "Generated Title",
      }),
    );
  });

  it("allows manual retitling even when automation is paused", () => {
    const controller = createSessionAutoTitleController({
      refreshTurns: 4,
      model: undefined,
    });
    const { ctx } = createControllerContext({
      sessionName: "Manual Title",
      entries: [
        createMessageEntry("user-1", null, "user", "Auto title me", 1),
        createMessageEntry("assistant-1", "user-1", "assistant", "Done", 2),
        createCustomStateEntry(
          createAutoTitleState({
            mode: "paused_manual",
            lastAutoTitle: "Generated Title",
            lastAppliedUserTurnCount: 1,
            lastTrigger: "initial",
          }),
        ),
      ],
      leafId: "custom-state-1",
    });

    controller.handleSessionStart(ctx);

    const plan = controller.handleManualRetitle(ctx);
    expect(plan).toEqual(
      expect.objectContaining({
        reason: "manual",
        currentTitle: "Manual Title",
      }),
    );
  });

  it("reactivates automation after a successful manual retitle", () => {
    const controller = createSessionAutoTitleController({
      refreshTurns: 4,
      model: undefined,
    });
    const { ctx } = createControllerContext();

    const plan = controller.handleManualRetitle(ctx);
    if (!plan) {
      throw new Error("Expected manual retitle plan");
    }

    const persistedState = controller.handleTitleApplied("Fresh Title", plan);

    expect(controller.getState().mode).toBe("active");
    expect(controller.getState().lastAutoTitle).toBe("Fresh Title");
    expect(persistedState).toEqual(
      expect.objectContaining({
        mode: "active",
        lastAutoTitle: "Fresh Title",
        lastTrigger: "manual",
      }),
    );
  });

  it("tracks the latest failure and dedupes repeated notifications until success", () => {
    const controller = createSessionAutoTitleController({
      refreshTurns: 4,
      model: undefined,
    });
    const { ctx } = createControllerContext();

    const failure = {
      at: "2026-03-23T00:00:03.000Z",
      trigger: "periodic" as const,
      model: "google/gemini-3-flash-preview",
      message: "quota exceeded",
      status: 429,
    };

    expect(controller.handleTitleFailed(ctx, failure)).toBe(true);
    expect(controller.getLastFailure(ctx)).toEqual(failure);
    expect(controller.getState().lastFailure).toEqual(failure);

    expect(controller.handleTitleFailed(ctx, failure)).toBe(false);

    const plan = controller.handleManualRetitle(ctx);
    if (!plan) {
      throw new Error("Expected manual retitle plan");
    }

    controller.handleTitleApplied("Recovered Title", plan);
    expect(controller.getLastFailure(ctx)).toBeUndefined();

    expect(controller.handleTitleFailed(ctx, failure)).toBe(true);
  });
});
