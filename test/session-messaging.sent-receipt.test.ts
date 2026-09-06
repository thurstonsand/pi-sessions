import { describe, expect, it, vi } from "vitest";
import { createSessionSendMessageTool } from "../extensions/session-messaging/pi/tools.ts";

const theme = {
  bold: (text: string) => text,
  fg: (_token: string, text: string) => text,
  bg: (_token: string, text: string) => text,
};

const args = {
  session: "target-1",
  message: "First line.\nSecond line.\nThird line.\nFourth line.",
  requestResponse: true,
};

const details = {
  delivered: true,
  messageId: "msg-1",
  target: { sessionId: "target-1", sessionName: "Target Session", cwd: "/repo/app" },
  relation: "child",
};

function getTool() {
  return createSessionSendMessageTool({ sendMessage: vi.fn() } as never, {
    role: { kind: "plain" },
    getCachedRelationTo: vi.fn(() => "child"),
  }) as {
    renderCall: (
      args: unknown,
      theme: unknown,
      context: unknown,
    ) => {
      render(width: number): string[];
    };
    renderResult: (
      result: unknown,
      options: unknown,
      theme: unknown,
      context: unknown,
    ) => { render(width: number): string[] };
  };
}

function renderCompleted(
  expanded: boolean,
  options: { width?: number; args?: typeof args } = {},
): string {
  const tool = getTool();
  const state = {};
  const renderArgs = options.args ?? args;
  const context = {
    args: renderArgs,
    state,
    expanded,
    isError: false,
    lastComponent: undefined,
  };
  const call = tool.renderCall(renderArgs, theme, context);
  tool.renderResult({ content: [], details }, { expanded, isPartial: false }, theme, context);
  return call.render(options.width ?? 100).join("\n");
}

describe("sent session-message tool receipt", () => {
  it("turns the completed tool call into the only sender receipt", () => {
    const rendered = renderCompleted(false);

    expect(rendered).toContain(
      "session_send_message delivered to Target Session (child, response requested)",
    );
    expect(rendered).toContain("First line.");
    expect(rendered).toContain("Second line.");
    expect(rendered).toContain("Third line.");
    expect(rendered).toContain("2 more lines, 5 total");
    expect(rendered).not.toContain("...");
    expect(rendered).not.toContain("Fourth line.");
    expect(rendered).not.toContain("session target-1");
  });

  it("keeps each collapsed preview row within the available width", () => {
    const rendered = renderCompleted(false, {
      width: 72,
      args: {
        ...args,
        message: `${"Long first line ".repeat(10)}\nSecond line.`,
      },
    });
    const lines = rendered.split("\n");
    const preview = lines.find((line) => line.includes("Long first line"));
    expect(preview).toHaveLength(72);
    expect(preview).toContain("Long first line");
    expect(rendered).not.toContain("Second line.");
    expect(rendered).toContain("2 more lines, 5 total");
  });

  it("adds the session id and complete message when expanded", () => {
    const rendered = renderCompleted(true);

    expect(rendered).toContain("session target-1");
    expect(rendered).toContain("Fourth line.");
  });
});
