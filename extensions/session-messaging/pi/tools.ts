import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { ExpandableContentLayout } from "../../shared/rendering/expandable-content-layout.ts";
import { safeParseTypeBoxValue } from "../../shared/typebox.ts";
import {
  SEND_MESSAGE_PARAMS,
  SEND_MESSAGE_TOOL_DETAILS_SCHEMA,
  type SendMessageParams,
  type SendMessageToolDetails,
} from "./message-contracts.ts";
import { buildSendMessagePresentation } from "./send-message-presenter.ts";
import { buildDeliveredMessageView, buildSendingMessageView } from "./send-message-view-model.ts";
import type { SessionMessagingService } from "./service.ts";

interface SendMessageRendererState {
  callComponent?: ExpandableContentLayout | undefined;
}

export function createSessionSendMessageTool(service: SessionMessagingService): ToolDefinition {
  return defineTool({
    name: "session_send_message",
    label: "Send Message to Session",
    description: "Send a message to another live pi session",
    promptSnippet: "Send a message to another live pi session",
    promptGuidelines: [
      "Before session_send_message, use session_search with live: true (no other filters) to list all live sessions and find the target.",
    ],
    parameters: SEND_MESSAGE_PARAMS,
    renderCall(args, theme, context) {
      const state = context.state as SendMessageRendererState;
      const component = state.callComponent ?? new ExpandableContentLayout(theme);
      state.callComponent = component;
      component.update(
        buildSendMessagePresentation(
          buildSendingMessageView(args, service.getCachedRelationTo(args?.session)),
          theme,
        ),
        context.expanded,
      );
      return component;
    },
    renderResult(result, options, theme, context) {
      if (context.isError) {
        const output = getFirstText(result);
        return new Text(output ? `\n${theme.fg("error", output)}` : "", 0, 0);
      }

      const details = safeParseTypeBoxValue(SEND_MESSAGE_TOOL_DETAILS_SCHEMA, result.details);
      const state = context.state as SendMessageRendererState;
      if (!details || !state.callComponent) {
        return new Text(getFirstText(result), 0, 0);
      }

      state.callComponent.update(
        buildSendMessagePresentation(buildDeliveredMessageView(context.args, details), theme),
        options.expanded,
      );
      return new Text("", 0, 0);
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
            target: result.target,
            ...(result.relation === undefined ? {} : { relation: result.relation }),
          } satisfies SendMessageToolDetails,
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
