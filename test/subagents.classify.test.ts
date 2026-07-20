import { describe, expect, it } from "vitest";
import { classifySubagent, type SubagentEvidence } from "../extensions/subagents/classify.ts";

const base: SubagentEvidence = {
  hasWindow: false,
  brokerLive: false,
  hasRegistered: false,
  cancelled: false,
  suspended: false,
  hasReportOrClosure: false,
  ownershipClosed: false,
  childReadable: true,
};

describe("subagent classification", () => {
  it.each([
    ["stopping", { hasWindow: true, cancelled: true }],
    ["starting", { hasWindow: true }],
    ["busy", { hasWindow: true, hasRegistered: true }],
    ["active", { brokerLive: true }],
    ["completed", { hasReportOrClosure: true, cancelled: true }],
    ["stopped", { cancelled: true }],
    ["suspended", { suspended: true }],
    ["interrupted", {}],
    ["unknown", { childReadable: false, hasWindow: true }],
  ] as const)("classifies %s from reducer precedence", (expected, evidence) => {
    expect(classifySubagent({ ...base, ...evidence })).toBe(expected);
  });
});
