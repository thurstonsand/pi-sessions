import { describe, expect, it } from "vitest";
import {
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

describe("handoff record discriminated union", () => {
  it("accepts a subagent record only with its identity block", () => {
    expect(
      parseHandoffSessionMetadata({ ...metadataBase, launch: "subagent", subagent: block }),
    ).toBeTruthy();
    expect(parseHandoffSessionMetadata({ ...metadataBase, launch: "subagent" })).toBeUndefined();
  });

  it("accepts a non-subagent record and rejects a stray subagent block on it", () => {
    expect(parseHandoffSessionMetadata({ ...metadataBase, launch: "deferred" })).toBeTruthy();
    expect(
      parseHandoffSessionMetadata({ ...metadataBase, launch: "deferred", subagent: block }),
    ).toBeUndefined();
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
