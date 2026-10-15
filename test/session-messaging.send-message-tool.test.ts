import { describe, expect, it, vi } from "vitest";
import { createSessionSendMessageTool } from "../extensions/session-messaging/pi/tools.ts";

describe("shared send tool", () => {
  it.each(["session_send_message", "subagent_send"])(
    "delivers through %s and protects a dynamically resolved parent",
    async (name) => {
      let parent: string | undefined;
      const sendMessage = vi.fn(async () => ({
        delivered: true as const,
        messageId: "message-1",
        target: { sessionId: "worker" },
      }));
      const tool = createSessionSendMessageTool(
        { sendMessage },
        {
          name,
          wording: { description: "Send", promptSnippet: "Send", promptGuidelines: [] },
          getCachedRelationTo: () => undefined,
          getParentSessionId: () => parent,
        },
      );
      const result = await tool.execute(
        "call-1",
        { session: "worker", message: " Taking the parser. " },
        undefined,
        undefined,
        {} as never,
      );
      expect(result.details).toEqual({
        delivered: true,
        messageId: "message-1",
        target: { sessionId: "worker" },
      });
      expect(sendMessage.mock.calls[0]).toEqual([
        {
          target: "worker",
          body: "Taking the parser.",
          requestResponse: undefined,
          sourceToolCallId: "call-1",
        },
        {},
      ]);
      parent = "worker";
      await expect(
        tool.execute(
          "call-2",
          { session: "worker", message: "Report" },
          undefined,
          undefined,
          {} as never,
        ),
      ).rejects.toThrow("Use submit_task_report");
      expect(sendMessage).toHaveBeenCalledOnce();
    },
  );
});
