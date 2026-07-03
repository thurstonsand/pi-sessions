import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { SEND_MESSAGE_PARAMS, type SendMessageParams } from "./message-contracts.ts";
import { formatSendMessageCall } from "./message-view.ts";
import type { SessionMessagingService } from "./service.ts";

export function registerSessionMessagingTools(
  pi: ExtensionAPI,
  service: SessionMessagingService,
): void {
  pi.registerTool({
    name: "session_send_message",
    label: "Send Message to Session",
    description: "Send a message to another live pi session",
    promptSnippet: "Send a message to another live pi session",
    promptGuidelines: [
      "Use session_search with live: true to discover targetable sessions. Usually it is best to exclude all other filters and simply get a list of all live sessions",
    ],
    parameters: SEND_MESSAGE_PARAMS,
    renderCall(args, theme, context) {
      const component = (context.lastComponent as Text | undefined) ?? new Text("", 0, 0);
      component.setText(
        formatSendMessageCall(
          args,
          context.expanded,
          "sending",
          theme,
          service.getCachedRelationTo(args?.session),
        ),
      );
      return component;
    },
    renderResult(result, _options, theme, context) {
      if (!context.isError) {
        return new Text("", 0, 0);
      }

      const output = getFirstText(result);
      return new Text(output ? `\n${theme.fg("error", output)}` : "", 0, 0);
    },
    async execute(toolCallId, params: SendMessageParams, _signal, _onUpdate, _ctx) {
      const target = params.session.trim();
      if (!target) {
        throw new Error("session_send_message requires a target session id.");
      }
      if (target.startsWith("@session:")) {
        throw new Error("Use the bare session UUID, not an @session token.");
      }

      const body = params.message.trim();
      if (!body) {
        throw new Error("session_send_message requires a non-empty message.");
      }

      try {
        const result = await service.sendMessage({
          target,
          body,
          requestResponse: params.requestResponse,
          sourceToolCallId: toolCallId,
        });
        if (!result.delivered) {
          throw new Error(result.error ?? "Message was not delivered.");
        }

        return {
          content: [
            {
              type: "text" as const,
              text: `Message delivered to ${target}.`,
            },
          ],
          details: {
            delivered: true,
            messageId: result.messageId,
            targetSessionId: target,
          },
        };
      } catch (error) {
        throw new Error(formatError(error));
      }
    },
  });
}

function getFirstText(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.find((item) => item.type === "text")?.text ?? "";
}

function formatError(error: unknown): string {
  return error instanceof Error && error.message.trim() ? error.message : String(error);
}
