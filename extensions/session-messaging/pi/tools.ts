import {
  defineTool,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { formatError } from "../../shared/errors.ts";
import { ExpandableContentLayout } from "../../shared/rendering/expandable-content-layout.ts";
import { safeParseTypeBoxValue } from "../../shared/typebox.ts";
import {
  buildCancelSessionModelText,
  buildCancelSessionUserError,
  buildCancelSessionUserText,
  buildDeadSessionError,
  buildUnknownCancellationError,
  isConfirmedManagedCancellation,
} from "./cancel-session-presenter.ts";
import {
  CANCEL_SESSION_PARAMS,
  CANCEL_SESSION_TOOL_DETAILS_SCHEMA,
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
  sendMessage(request: SendMessageRequest, ctx: ExtensionContext): Promise<SendMessageResult>;
}

/** A subagent's cancel goes through its parent's ledger, which reports the state it reconciled to. */
export interface ManagedCancelSessionResult {
  kind: "managed";
  accepted: true;
  target: {
    sessionId: string;
    sessionName?: string;
    cwd?: string;
  };
  state: string;
  cancelId?: string;
  relation?: string;
}

interface CancelSessionService {
  cancelSession(
    sessionId: string,
    ctx: ExtensionContext,
  ): Promise<CancelSessionResult | ManagedCancelSessionResult>;
}

export interface SessionSendMessageToolOptions {
  name: string;
  wording: SendMessageToolWording;
  getCachedRelationTo(sessionId: string | undefined): string | undefined;
  /**
   * Resolved on every call: subagent identity depends on the active branch, so a rewind can
   * turn a plain session into a subagent without re-registering this tool.
   */
  getParentSessionId?: (() => string | undefined) | undefined;
}

export interface SessionCancelToolOptions {
  name: string;
  wording: SendMessageToolWording;
  /**
   * Resolved on every call: subagent identity depends on the active branch, so a rewind can
   * turn a plain session into a subagent without re-registering this tool.
   */
  getParentSessionId?: (() => string | undefined) | undefined;
}

export interface SendMessageToolWording {
  description: string;
  promptSnippet: string;
  promptGuidelines: string[];
}

interface SendMessageRendererState {
  callComponent?: ExpandableContentLayout | undefined;
}

export function createSessionSendMessageTool(
  service: SendMessageService,
  options: SessionSendMessageToolOptions,
): ToolDefinition {
  const { description, promptSnippet, promptGuidelines } = options.wording;

  return defineTool({
    name: options.name,
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
          options.name,
        ),
        context.expanded,
      );
      return component;
    },
    renderResult(result, renderOptions, theme, context) {
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
        buildSendMessagePresentation(
          buildDeliveredMessageView(context.args, details),
          theme,
          options.name,
        ),
        renderOptions.expanded,
      );
      return new Text("", 0, 0);
    },
    async execute(toolCallId, params: SendMessageParams, _signal, _onUpdate, ctx) {
      const target = parseSessionTarget(params.session, options.name);
      if (target === options.getParentSessionId?.()) {
        throw new Error("The parent session cannot be messaged. Use submit_task_report.");
      }

      const body = params.message.trim();
      if (!body) {
        throw new Error(`${options.name} requires a non-empty message.`);
      }

      try {
        const result = await service.sendMessage(
          {
            target,
            body,
            requestResponse: params.requestResponse,
            sourceToolCallId: toolCallId,
          },
          ctx,
        );
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

export function createSessionCancelTool(
  service: CancelSessionService,
  options: SessionCancelToolOptions,
): ToolDefinition {
  return defineTool<typeof CANCEL_SESSION_PARAMS, CancelSessionToolDetails>({
    name: options.name,
    label: "Cancel a running session",
    ...options.wording,
    parameters: CANCEL_SESSION_PARAMS,
    renderResult(result, options, theme, context) {
      const output = getFirstText(result);
      if (context.isError) {
        const error = buildCancelSessionUserError(output, options.expanded);
        return new Text(error ? theme.fg("error", error) : "", 0, 0);
      }

      const details = safeParseTypeBoxValue(CANCEL_SESSION_TOOL_DETAILS_SCHEMA, result.details);
      if (!details) {
        return new Text(output, 0, 0);
      }

      let text = theme.fg("toolOutput", buildCancelSessionUserText(details));
      if (options.expanded && details.target.sessionName) {
        text += `\n${theme.fg("dim", `${theme.bold("session")} ${details.target.sessionId}`)}`;
      }
      return new Text(text, 0, 0);
    },
    async execute(_toolCallId, params: CancelSessionParams, _signal, _onUpdate, ctx) {
      const target = parseSessionTarget(params.session, options.name);
      if (target === options.getParentSessionId?.()) {
        throw new Error("The parent session cannot be cancelled. It is waiting on your report.");
      }

      const result = await service.cancelSession(target, ctx);
      if (result.kind === "managed") {
        if (!isConfirmedManagedCancellation(result.state)) {
          throw new Error(buildUnknownCancellationError(result.target));
        }
        const details: CancelSessionToolDetails = {
          kind: "managed",
          accepted: true,
          target: result.target,
          state: result.state,
          ...(result.cancelId === undefined ? {} : { cancelId: result.cancelId }),
          ...(result.relation === undefined ? {} : { relation: result.relation }),
        };
        return {
          content: [{ type: "text" as const, text: buildCancelSessionModelText(details) }],
          details,
        };
      }
      if (!result.delivered) {
        if (result.reason === "no_session") {
          throw new Error(buildDeadSessionError(target));
        }
        throw new Error(result.error ?? "Cancellation was not delivered.");
      }

      const details: CancelSessionToolDetails = {
        kind: "transport",
        delivered: true,
        cancelId: result.cancelId,
        target: result.target,
        ...(result.relation === undefined ? {} : { relation: result.relation }),
      };
      return {
        content: [{ type: "text" as const, text: buildCancelSessionModelText(details) }],
        details,
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
