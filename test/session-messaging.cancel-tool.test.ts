import { describe, expect, it, vi } from "vitest";
import { createSessionCancelTool } from "../extensions/session-messaging/pi/tools.ts";

describe("shared cancel tool", () => {
  it.each(["session_cancel", "subagent_cancel"])(
    "cancels through %s and protects a dynamically resolved parent",
    async (name) => {
      let parent: string | undefined;
      const cancelSession = vi.fn(async () => ({
        kind: "transport" as const,
        delivered: true as const,
        cancelId: "cancel-1",
        target: { sessionId: "worker" },
      }));
      const tool = createSessionCancelTool(
        { cancelSession },
        {
          name,
          wording: { description: "Cancel", promptSnippet: "Cancel", promptGuidelines: [] },
          getParentSessionId: () => parent,
        },
      );
      const result = await tool.execute(
        "call-1",
        { session: "worker" },
        undefined,
        undefined,
        {} as never,
      );
      expect(result.details).toEqual({
        kind: "transport",
        delivered: true,
        cancelId: "cancel-1",
        target: { sessionId: "worker" },
      });
      parent = "worker";
      await expect(
        tool.execute("call-2", { session: "worker" }, undefined, undefined, {} as never),
      ).rejects.toThrow("parent session cannot be cancelled");
      expect(cancelSession).toHaveBeenCalledOnce();
    },
  );
});
