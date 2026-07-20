import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { formatError } from "../../shared/errors.ts";
import { ExpandableContentLayout } from "../../shared/rendering/expandable-content-layout.ts";
import { safeParseTypeBoxValue } from "../../shared/typebox.ts";
import {
  CANCEL_SESSION_PARAMS,
  type CancelSessionParams,
  type CancelSessionToolDetails,
  SEND_MESSAGE_PARAMS,
  SEND_MESSAGE_TOOL_DETAILS_SCHEMA,
  type SendMessageParams,
  type SendMessageToolDetails,
} from "./message-contracts.ts";
import { buildSendMessagePresentation } from "./send-message-presenter.ts";
import { buildDeliveredMessageView, buildSendingMessageView } from "./send-message-view-model.ts";
import type { CancelSessionResult, SendMessageRequest, SendMessageResult } from "./service.ts";

interface SendMessageService {
  sendMessage(request: SendMessageRequest): Promise<SendMessageResult>;
}

interface CancelSessionService {
  cancelSession(sessionId: string): Promise<CancelSessionResult>;
}

export interface SessionSendMessageToolOptions {
  wakeCapable: boolean;
  getCachedRelationTo(sessionId: string | undefined): string | undefined;
}

interface SendMessageRendererState {
  callComponent?: ExpandableContentLayout | undefined;
}

export function createSessionSendMessageTool(
  service: SendMessageService,
  options: SessionSendMessageToolOptions,
): ToolDefinition {
  const description = options.wakeCapable
    ? "Send a message to another live pi session or a subagent."
    : "Send a message to another live pi session.";
  const promptSnippet = options.wakeCapable
    ? "Send a message to another pi session or a subagent"
    : "Send a message to another live pi session";
  const promptGuidelines = options.wakeCapable
    ? [
        "Use session_search with live: true to discover live sessions.",
        "It is always possible to session_send_message to an owned subagent",
      ]
    : [
        "Before session_send_message, use session_search with live: true to list all live sessions and find the target.",
      ];

  return defineTool({
    name: "session_send_message",
    label: "Send Message to Session",
    description,
    promptSnippet,
    promptGuidelines,
    parameters: SEND_MESSAGE_PARAMS,
    renderCall(args, theme, context) {
      const state = context.state as SendMessageRendererState;
      const component = state.callComponent ?? new ExpandableContentLayout(theme);
      state.callComponent = component;
      component.update(
        buildSendMessagePresentation(
          buildSendingMessageView(args, options.getCachedRelationTo(args?.session)),
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
      const target = parseSessionTarget(params.session, "session_send_message");

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

export function createSessionCancelTool(service: CancelSessionService): ToolDefinition {
  return defineTool({
    name: "session_cancel",
    label: "Cancel a running session",
    description: "Cancel another running pi session",
    promptSnippet: "Cancel another running pi session",
    promptGuidelines: ["Only cancel a user session when the user directs it."],
    parameters: CANCEL_SESSION_PARAMS,
    async execute(_toolCallId, params: CancelSessionParams) {
      const target = parseSessionTarget(params.session, "session_cancel");
      const result = await service.cancelSession(target);
      if (!result.delivered) {
        throw new Error(result.error ?? "Cancellation was not delivered.");
      }

      return {
        content: [
          {
            type: "text" as const,
            text: `Cancellation delivered to ${target}.`,
          },
        ],
        details: {
          delivered: true,
          cancelId: result.cancelId,
          target: result.target,
          ...(result.relation === undefined ? {} : { relation: result.relation }),
        } satisfies CancelSessionToolDetails,
      };
    },
  });
}

function parseSessionTarget(raw: string, toolName: string): string {
  const target = raw.trim();
  if (!target) {
    throw new Error(`${toolName} requires a target session id.`);
  }
  if (target.startsWith("@session:")) {
    throw new Error("Use the bare session UUID, not an @session token.");
  }
  return target;
}

function getFirstText(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.find((item) => item.type === "text")?.text ?? "";
}
