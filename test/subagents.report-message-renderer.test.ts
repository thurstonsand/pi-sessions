import { describe, expect, it } from "vitest";
import { renderSubagentReportMessage } from "../extensions/subagents/report-message-renderer.ts";

const theme = {
  bold: (text: string) => text,
  fg: (_token: string, text: string) => text,
  bg: (_token: string, text: string) => text,
};

function render(details: unknown): string | undefined {
  const component = (
    renderSubagentReportMessage as unknown as (
      message: unknown,
      options: { expanded: boolean },
      rendererTheme: typeof theme,
    ) => { render(width: number): string[] } | undefined
  )({ content: "model-facing provenance must not render", details }, { expanded: false }, theme);

  return component
    ?.render(80)
    .map((line) => line.trim())
    .join("\n");
}

function report(status: "done" | "blocked" | "incomplete" = "done") {
  return {
    writerSessionId: "parent-session",
    childSessionId: "child-session",
    reportId: "report-1",
    title: "Implement phase",
    status,
    summary: "Implemented and tested.",
    details: "The focused checks pass.",
    references: [
      { reference: "test/example.test.ts", description: "Coverage" },
      { reference: "npm run typecheck" },
    ],
    nextSteps: ["Review the diff."],
    provenance: "live",
  };
}

describe("subagent report-message renderer", () => {
  it("renders a done report from structured details without model provenance", () => {
    const rendered = render(report());

    expect(rendered).toContain("Report from subagent “Implement phase”");
    expect(rendered).not.toContain("[done]");
    expect(rendered).toContain("Summary\nImplemented and tested.");
    expect(rendered).toContain("Details\nThe focused checks pass.");
    expect(rendered).toContain(
      "References\n- test/example.test.ts — Coverage\n- npm run typecheck",
    );
    expect(rendered).toContain("Next steps\n- Review the diff.");
    expect(rendered).not.toContain("model-facing provenance");
    expect(rendered).not.toContain("Subagent report from");
  });

  it.each([
    "blocked",
    "incomplete",
  ] as const)("includes [%s] in a non-done report header", (status) => {
    expect(render(report(status))).toContain(`Report from subagent [${status}] “Implement phase”`);
  });

  it("returns no component for malformed or legacy details", () => {
    expect(render(null)).toBeUndefined();
    const { title: _title, ...legacy } = report();
    expect(render(legacy)).toBeUndefined();
  });
});
