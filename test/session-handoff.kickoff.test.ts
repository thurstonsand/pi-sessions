import { describe, expect, it } from "vitest";
import {
  buildHandoffKickoffMessage,
  HANDOFF_KICKOFF_CUSTOM_TYPE,
  renderHandoffKickoffMessage,
  renderHandoffKickoffView,
} from "../extensions/session-handoff/kickoff.ts";
import { hasStartedConversation } from "../extensions/session-handoff/metadata.ts";

const theme = {
  bold: (text: string) => text,
  fg: (_token: string, text: string) => text,
  bg: (_token: string, text: string) => text,
};

describe("handoff kickoff message", () => {
  it("carries the exact approved prompt as content", () => {
    const message = buildHandoffKickoffMessage({
      prompt: "Full approved prompt body.",
      title: "Index fix",
      source: { sessionId: "parent-1", sessionName: "Parent Session" },
    });

    expect(message.customType).toBe(HANDOFF_KICKOFF_CUSTOM_TYPE);
    expect(message.content).toBe("Full approved prompt body.");
    expect(message.display).toBe(true);
    expect(message.details).toEqual({
      source: { sessionId: "parent-1", sessionName: "Parent Session" },
      title: "Index fix",
    });
  });

  it("omits missing parent names from details", () => {
    const message = buildHandoffKickoffMessage({
      prompt: "Prompt",
      title: "Title",
      source: { sessionId: "parent-1" },
    });

    expect(message.details?.source).toEqual({ sessionId: "parent-1" });
  });

  it("renders the full approved prompt", () => {
    const details = {
      source: { sessionId: "parent-1", sessionName: "Parent Session" },
      title: "Index fix",
    };

    const rendered = renderHandoffKickoffView(details, "Full approved prompt body.", theme);
    expect(rendered).toContain("handoff Index fix");
    expect(rendered).toContain("from Parent Session (parent-1)");
    expect(rendered).toContain("Full approved prompt body.");
  });

  it("falls back to the bare uuid for untitled parents", () => {
    const view = renderHandoffKickoffView(
      { source: { sessionId: "parent-1" }, title: "Title" },
      "Prompt",
      theme,
    );
    expect(view).toContain("from parent-1");
    expect(view).not.toContain("(parent-1)");
  });

  it("honors the configured output padding", () => {
    const renderer = renderHandoffKickoffMessage as unknown as (
      message: unknown,
      options: { expanded: boolean; outputPad: number },
      rendererTheme: typeof theme,
    ) => { render(width: number): string[] } | undefined;
    const message = buildHandoffKickoffMessage({
      prompt: "Prompt",
      title: "Title",
      source: { sessionId: "parent-1" },
    });
    const renderHeader = (outputPad: number) =>
      renderer(message, { expanded: false, outputPad }, theme)
        ?.render(80)
        .find((line) => line.includes("handoff Title"));

    expect(renderHeader(1)).toMatch(/^ /);
    expect(renderHeader(0)).toMatch(/^handoff Title/);
  });
});

describe("bootstrap freshness", () => {
  it("treats an existing kickoff as a started conversation", () => {
    const entries = [
      {
        type: "custom_message",
        id: "kickoff-1",
        parentId: null,
        timestamp: "2026-01-01T00:00:00.000Z",
        customType: HANDOFF_KICKOFF_CUSTOM_TYPE,
        content: "Approved prompt",
      },
    ] as never[];

    expect(hasStartedConversation(entries)).toBe(true);
  });

  it("ignores unrelated custom messages", () => {
    const entries = [
      {
        type: "custom_message",
        id: "other-1",
        parentId: null,
        timestamp: "2026-01-01T00:00:00.000Z",
        customType: "some-other-extension.message",
        content: "irrelevant",
      },
    ] as never[];

    expect(hasStartedConversation(entries)).toBe(false);
  });

  it("still counts native user messages", () => {
    const entries = [
      {
        type: "message",
        id: "user-1",
        parentId: null,
        timestamp: "2026-01-01T00:00:00.000Z",
        message: { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 },
      },
    ] as never[];

    expect(hasStartedConversation(entries)).toBe(true);
  });
});
