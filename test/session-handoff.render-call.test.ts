import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { HandoffToolComponent } from "../extensions/session-handoff/tool-renderer.ts";
import { buildHandoffToolView } from "../extensions/session-handoff/tool-view-model.ts";

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as never;

const args = {
  goal: "Inspect the index recovery path and report concrete failure modes.",
  title: "Index recovery audit",
  launch: "deferred",
  cwd: "/repo/app",
  model: "openai/gpt-5.4",
  thinkingLevel: "high",
  requestResponse: true,
};

const details = {
  sessionId: "child-1",
  title: "Index recovery audit",
  launch: "deferred" as const,
  childSessionFile: "/tmp/child-1.jsonl",
  resumeCommand: "pi --session-id 'child-1'",
  cwd: "/repo/app",
  model: "openai/gpt-5.4:high",
  modelName: "GPT 5.4",
  thinkingLevel: "high" as const,
};

function render(
  renderArgs: unknown,
  result: typeof details | undefined,
  expanded: boolean,
  width = 120,
): string {
  const component = new HandoffToolComponent(theme);
  component.update(buildHandoffToolView(renderArgs, result), expanded, "copied");
  return component.render(width).join("\n");
}

describe("session_handoff tool renderer", () => {
  it("renders pending placeholders for empty arguments", () => {
    const lines = render(undefined, undefined, false)
      .split("\n")
      .map((line) => line.trimEnd());
    expect(lines.slice(0, 3)).toEqual([
      "session_handoff […] …",
      "model …  ·  thinking …",
      "goal …",
    ]);
  });

  it("tolerates malformed and progressively streamed arguments", () => {
    expect(render("garbage", undefined, false)).toContain("session_handoff");
    expect(render({ goal: 42, launch: {} }, undefined, false)).toContain("goal …");
    const lines = render({ launch: "subagent", goal: "Fix the ind" }, undefined, false)
      .split("\n")
      .map((line) => line.trimEnd());
    expect(lines.slice(0, 3)).toEqual([
      "session_handoff [subagent] …",
      "model …  ·  thinking …",
      "goal Fix the ind",
    ]);
  });

  it("keeps effective launch metadata in the compact call", () => {
    const rendered = render(args, undefined, false);
    expect(rendered).toContain("session_handoff [deferred] Index recovery audit");
    expect(rendered).toContain("model openai/gpt-5.4  ·  thinking high");
    expect(rendered).not.toContain("cwd /repo/app");
    expect(rendered).not.toContain("requests a response");
  });

  it("renders a compact completed card", () => {
    const rendered = render(args, details, false);
    expect(rendered).toContain("goal Inspect the index recovery path");
    expect(rendered).toContain("resume command · copied to clipboard");
    expect(rendered).toContain("pi --session-id 'child-1'");
    expect(rendered).toContain("model GPT 5.4  ·  thinking high");
    expect(rendered).not.toContain("session child-1");
    expect(rendered).not.toContain("model openai/gpt-5.4:high");
  });

  it("keeps the collapsed goal to one row followed by an expansion hint", () => {
    const rendered = render(args, details, false, 40);
    const lines = rendered.split("\n");
    const goalIndex = lines.findIndex((line) => line.startsWith("goal "));
    expect(visibleWidth(lines[goalIndex] ?? "")).toBe(40);
    expect(rendered).toContain("3 more lines, 5 total");
    expect(rendered).not.toContain("...");
  });

  it("adds full goal and result metadata when expanded", () => {
    const rendered = render(args, details, true);
    expect(rendered).toContain("session child-1");
    expect(rendered).toContain("model GPT 5.4  ·  thinking high");
    expect(rendered).not.toContain("model openai/gpt-5.4:high");
    expect(rendered).toContain("cwd /repo/app");
  });
});
