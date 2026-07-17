import { describe, expect, it } from "vitest";
import { buildSendMessagePresentation } from "../extensions/session-messaging/pi/send-message-presenter.ts";

const theme = {
  bold: (text: string) => text,
  fg: (_token: string, text: string) => text,
  bg: (_token: string, text: string) => text,
};

describe("send-message presenter", () => {
  it("maps a delivered view model into generic expandable content", () => {
    expect(
      buildSendMessagePresentation(
        {
          status: "delivered",
          targetSessionId: "target-1",
          targetSessionName: "Target Session",
          relation: "child",
          requestResponse: true,
          body: "Message body.",
        },
        theme,
      ),
    ).toEqual({
      header: "session_send_message delivered to Target Session (child, response requested)",
      expandedMetadata: ["session target-1"],
      body: { text: "Message body.", collapsedRows: 3 },
    });
  });
});
