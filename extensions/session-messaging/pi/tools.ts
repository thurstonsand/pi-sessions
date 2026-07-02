import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { SEND_MESSAGE_PARAMS, type SendMessageParams } from "./message-contracts.ts";
import { formatSendMessageCall } from "./message-view.ts";
import type { LiveSessionRow, SessionMessagingService } from "./service.ts";

interface ListLiveDetails {
  error?: boolean | undefined;
  sessions: LiveSessionRow[];
}

export function registerSessionMessagingTools(
  pi: ExtensionAPI,
  service: SessionMessagingService,
): void {
  pi.registerTool({
    name: "session_list_live",
    label: "List Live Pi Sessions",
    description: "List other Pi sessions that are currently active.",
    promptSnippet: "List other Pi sessions that are currently active.",
    parameters: Type.Object({}),
    renderResult(result, _options, theme, context) {
      if (context.isError) {
        return new Text(`\n${theme.fg("error", getFirstText(result))}`, 0, 0);
      }

      const details = result.details as ListLiveDetails | undefined;
      return new Text(`\n${formatLiveSessionsForDisplay(details?.sessions ?? [], theme)}`, 0, 0);
    },
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      try {
        const sessions = await service.listLiveSessions(ctx);
        return {
          content: [{ type: "text" as const, text: formatLiveSessions(sessions) }],
          details: { sessions } satisfies ListLiveDetails,
        };
      } catch (error) {
        throw new Error(formatError(error));
      }
    },
  });

  pi.registerTool({
    name: "session_send_message",
    label: "Send Message to Session",
    description: "Send a message to another live pi session",
    promptSnippet: "Send a message to another live pi session",
    promptGuidelines: ["Use session_list_live to discover targetable sessions."],
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

function formatLiveSessions(sessions: LiveSessionRow[]): string {
  return JSON.stringify({ sessions }, null, 2);
}

function formatLiveSessionsForDisplay(
  sessions: LiveSessionRow[],
  theme: { fg(token: string, text: string): string },
): string {
  if (sessions.length === 0) {
    return "No other live sessions found.";
  }

  return sessions
    .map((session) => {
      const title = session.sessionName?.trim() || "[untitled]";
      const relation = session.relation ? ` (${session.relation})` : "";
      return `${session.sessionId}${relation} - ${title}\n${theme.fg("dim", session.cwd)}`;
    })
    .join("\n\n");
}

function getFirstText(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.find((item) => item.type === "text")?.text ?? "";
}

function formatError(error: unknown): string {
  return error instanceof Error && error.message.trim() ? error.message : String(error);
}
