import { describe, expect, it } from "vitest";
import {
  AUTO_TITLE_STATE_CUSTOM_TYPE,
  createAutoTitleState,
  getLatestAutoTitleState,
  parseAutoTitleState,
} from "../extensions/session-auto-title/state.js";

describe("session auto-title state", () => {
  it("creates persisted state payloads without re-normalizing stored titles", () => {
    expect(
      createAutoTitleState({
        lastAutoTitle: "  Investigate session naming  ",
        lastAppliedUserTurnCount: 4,
        lastTrigger: "periodic",
        updatedAt: "2026-03-23T00:00:00.000Z",
      }),
    ).toEqual({
      version: 1,
      mode: "active",
      lastAutoTitle: "  Investigate session naming  ",
      lastAppliedUserTurnCount: 4,
      lastTrigger: "periodic",
      updatedAt: "2026-03-23T00:00:00.000Z",
    });
  });

  it("parses the latest valid auto-title state from branch entries", () => {
    const latestState = createAutoTitleState({
      mode: "paused_manual",
      lastAutoTitle: "Better title",
      lastAppliedUserTurnCount: 2,
      lastTrigger: "initial",
      updatedAt: "2026-03-23T00:00:02.000Z",
    });

    const state = getLatestAutoTitleState([
      {
        type: "custom",
        id: "state-1",
        parentId: null,
        timestamp: "2026-03-23T00:00:01.000Z",
        customType: AUTO_TITLE_STATE_CUSTOM_TYPE,
        data: { version: 99 },
      },
      {
        type: "custom",
        id: "state-2",
        parentId: "state-1",
        timestamp: "2026-03-23T00:00:02.000Z",
        customType: AUTO_TITLE_STATE_CUSTOM_TYPE,
        data: latestState,
      },
    ] as never);

    expect(state).toEqual(latestState);
  });

  it("rejects invalid persisted state payloads", () => {
    expect(parseAutoTitleState({ mode: "active" })).toBeUndefined();
  });
});
