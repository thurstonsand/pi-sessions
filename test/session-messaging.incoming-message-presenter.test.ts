import { describe, expect, it } from "vitest";
import { buildIncomingMessagePresentation } from "../extensions/session-messaging/pi/incoming-message-presenter.ts";

const theme = {
  bold: (text: string) => text,
  fg: (_token: string, text: string) => text,
  bg: (_token: string, text: string) => text,
};

describe("incoming-message presenter", () => {
  it("maps the view model into generic expandable content", () => {
    expect(
      buildIncomingMessagePresentation(
        {
          sourceSessionId: "source-1",
          sourceSessionName: "Source Session",
          relation: "parent",
          requestResponse: true,
          body: "Message body.",
        },
        theme,
      ),
    ).toEqual({
      header: "incoming_message from Source Session (source-1) (parent, response requested)",
      body: { text: "Message body.", collapsedRows: 3 },
    });
  });
});
