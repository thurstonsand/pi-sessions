import { describe, expect, it } from "vitest";
import {
  findSubagentIdentity,
  SUBAGENT_IDENTITY_CUSTOM_TYPE,
} from "../extensions/subagents/identity.ts";

const identityEntry = {
  type: "custom",
  id: "identity-1",
  parentId: null,
  timestamp: "2026-03-25T00:00:00.000Z",
  customType: SUBAGENT_IDENTITY_CUSTOM_TYPE,
  data: {
    childSessionId: "child-original",
    ownerSessionId: "parent-session",
    parentSessionFile: "/tmp/parent.jsonl",
    depth: 1,
    requestResponse: true,
  },
};

describe("subagent identity", () => {
  it("recognizes the original prepared child", () => {
    expect(findSubagentIdentity([identityEntry] as never, "child-original")).toEqual(
      identityEntry.data,
    );
  });

  it("disowns a fork that copied the identity record", () => {
    expect(findSubagentIdentity([identityEntry] as never, "fork-session")).toBeUndefined();
  });
});
