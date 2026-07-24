import { describe, expect, it } from "vitest";
import {
  createHandoffSessionMetadata,
  HANDOFF_BOOTSTRAP_SCHEMA,
  parseHandoffSessionMetadata,
} from "../extensions/session-handoff/metadata.ts";
import { safeParseTypeBoxValue } from "../extensions/shared/typebox.ts";

const metadataBase = { origin: "handoff", goal: "g", title: "t", initial_prompt: "p" };
const bootstrapBase = {
  mode: "generate",
  sessionId: "child",
  goal: "g",
  title: "t",
  parentSessionFile: "/tmp/parent.jsonl",
  sourceLeafId: "leaf",
  requestResponse: true,
  bootstrapMode: "automatic",
};
const block = { childSessionId: "child", ownerSessionId: "owner", depth: 1, requestResponse: true };

describe("handoff records", () => {
  it("keeps subagent identity out of authored handoff metadata", () => {
    expect(createHandoffSessionMetadata("g", "p", "t", "subagent")).toEqual({
      ...metadataBase,
      launch: "subagent",
    });
    expect(parseHandoffSessionMetadata({ ...metadataBase, launch: "deferred" })).toBeTruthy();
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
