import { describe, expect, it } from "vitest";
import { renderIncomingSessionMessage } from "../extensions/session-messaging/pi/renderer.ts";

const theme = {
  bold: (text: string) => text,
  fg: (_token: string, text: string) => text,
  bg: (_token: string, text: string) => text,
};

const received = {
  messageId: "msg-1",
  source: { sessionId: "source-1", sessionName: "Source Session" },
  target: { sessionId: "target-1" },
  body: `${"Long incoming row ".repeat(10)}\nSecond row.\nThird row.\nFourth row.`,
  sentAt: "2026-01-01T00:00:00.000Z",
  receivedAt: "2026-01-01T00:00:01.000Z",
  requestResponse: true,
  relation: "parent",
};

function getRenderer() {
  return renderIncomingSessionMessage as unknown as (
    message: unknown,
    options: { expanded: boolean; outputPad: number },
    rendererTheme: typeof theme,
  ) => { render(width: number): string[] } | undefined;
}

function renderIncoming(expanded: boolean, outputPad = 1): string {
  const component = getRenderer()({ details: received }, { expanded, outputPad }, theme);
  if (!component) {
    throw new Error("Incoming message renderer returned no component.");
  }
  return component.render(72).join("\n");
}

describe("incoming session-message renderer", () => {
  it("uses the shared reactive three-row body when collapsed", () => {
    const rendered = renderIncoming(false);

    expect(rendered).toContain("incoming_message from Source Session (source-1)");
    expect(rendered).toContain("Long incoming row");
    expect(rendered).toContain("more lines");
    expect(rendered).not.toContain("...");
    expect(rendered).not.toContain("Second row.");
    expect(rendered).not.toContain("Third row.");
    expect(rendered).not.toContain("Fourth row.");
  });

  it("shows the complete message when expanded", () => {
    expect(renderIncoming(true)).toContain("Fourth row.");
  });

  it("honors the configured output padding", () => {
    const paddedHeader = renderIncoming(false, 1)
      .split("\n")
      .find((line) => line.includes("incoming_message"));
    const unpaddedHeader = renderIncoming(false, 0)
      .split("\n")
      .find((line) => line.includes("incoming_message"));

    expect(paddedHeader).toMatch(/^ /);
    expect(unpaddedHeader).toMatch(/^incoming_message/);
  });

  it("returns no component for malformed details", () => {
    expect(
      getRenderer()({ details: null }, { expanded: false, outputPad: 1 }, theme),
    ).toBeUndefined();
  });
});
