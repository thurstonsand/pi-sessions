import { describe, expect, it } from "vitest";
import {
  createHandoffSessionMetadata,
  findPendingHandoffBootstrap,
  HANDOFF_BOOTSTRAP_PENDING_CUSTOM_TYPE,
  HANDOFF_BOOTSTRAP_SCHEMA,
  parseHandoffSessionMetadata,
} from "../extensions/session-handoff/metadata.ts";
import { safeParseTypeBoxValue } from "../extensions/shared/typebox.ts";

const metadataBase = { origin: "handoff", briefing: "g", title: "t", initial_prompt: "p" };
const bootstrapBase = {
  mode: "generate",
  sessionId: "child",
  briefing: "g",
  title: "t",
  parentSessionFile: "/tmp/parent.jsonl",
  sourceLeafId: "leaf",
  reportBack: true,
  bootstrapMode: "automatic",
};
const block = { childSessionId: "child", ownerSessionId: "owner", depth: 1, reportBack: true };

describe("handoff records", () => {
  it("keeps subagent identity out of authored handoff metadata", () => {
    expect(createHandoffSessionMetadata("g", "p", "t", "subagent")).toEqual({
      ...metadataBase,
      launch: "subagent",
    });
    expect(parseHandoffSessionMetadata({ ...metadataBase, launch: "deferred" })).toBeTruthy();
  });

  it("reads metadata and bootstraps written before the snake_case rename", () => {
    expect(
      parseHandoffSessionMetadata({
        origin: "handoff",
        goal: "g",
        title: "t",
        initial_prompt: "p",
        launch: "deferred",
      }),
    ).toMatchObject({ briefing: "g" });
    const { briefing, reportBack, ...legacyBootstrap } = bootstrapBase;
    const scan = findPendingHandoffBootstrap([
      {
        type: "custom",
        id: "bootstrap",
        parentId: null,
        timestamp: "2026-03-25T00:00:00.000Z",
        customType: HANDOFF_BOOTSTRAP_PENDING_CUSTOM_TYPE,
        data: {
          ...legacyBootstrap,
          goal: briefing,
          requestResponse: reportBack,
          launch: "subagent",
          subagent: {
            childSessionId: "child",
            ownerSessionId: "owner",
            depth: 1,
            requestResponse: true,
          },
        },
      },
    ]);

    expect(scan).toMatchObject({
      kind: "pending",
      bootstrap: { briefing: "g", reportBack: true, subagent: { reportBack: true } },
    });
  });

  it("enforces the same invariant on the pending bootstrap", () => {
    expect(
      safeParseTypeBoxValue(HANDOFF_BOOTSTRAP_SCHEMA, {
        ...bootstrapBase,
        launch: "subagent",
        subagent: block,
      }),
    ).toBeTruthy();
    expect(
      safeParseTypeBoxValue(HANDOFF_BOOTSTRAP_SCHEMA, { ...bootstrapBase, launch: "subagent" }),
    ).toBeUndefined();
    expect(
      safeParseTypeBoxValue(HANDOFF_BOOTSTRAP_SCHEMA, {
        ...bootstrapBase,
        launch: "deferred",
        subagent: block,
      }),
    ).toBeUndefined();
  });
});
