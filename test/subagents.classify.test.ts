import { describe, expect, it } from "vitest";
import { classifySubagent, type SubagentEvidence } from "../extensions/subagents/classify.ts";

const base: SubagentEvidence = {
  hasWindow: false,
  brokerLive: false,
  hasRegistered: false,
  awaitingKickoff: false,
  cancelled: false,
  suspended: false,
  hasReportOrClosure: false,
  childReadable: true,
};

describe("subagent classification", () => {
  it.each([
    ["stopping", { hasWindow: true, cancelled: true }],
    ["starting", { hasWindow: true }],
    ["busy", { hasWindow: true, hasRegistered: true }],
    ["active", { brokerLive: true }],
    ["stopped", { cancelled: true }],
    ["suspended", { suspended: true }],
    ["interrupted", {}],
    ["unknown", { childReadable: false, hasWindow: true }],
  ] as const)("classifies %s from reducer precedence", (expected, evidence) => {
    expect(classifySubagent({ ...base, ...evidence })).toBe(expected);
  });

  it("keeps a registered child starting while it awaits kickoff", () => {
    expect(
      classifySubagent({
        ...base,
        hasWindow: true,
        brokerLive: true,
        hasRegistered: true,
        awaitingKickoff: true,
      }),
    ).toBe("starting");
  });

  it("classifies registered children normally after kickoff", () => {
    expect(classifySubagent({ ...base, hasWindow: true, hasRegistered: true })).toBe("busy");
    expect(classifySubagent({ ...base, brokerLive: true, hasRegistered: true })).toBe("active");
  });

  it("lets cancellation stop a child that still awaits kickoff", () => {
    expect(
      classifySubagent({
        ...base,
        hasWindow: true,
        hasRegistered: true,
        awaitingKickoff: true,
        cancelled: true,
      }),
    ).toBe("stopping");
  });

  it("lets completion win when a report races cancellation", () => {
    expect(classifySubagent({ ...base, hasReportOrClosure: true, cancelled: true })).toBe(
      "completed",
    );
  });
});
