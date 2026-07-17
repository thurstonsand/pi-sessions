import type { ExpandableContentPresentation } from "../../shared/rendering/expandable-content-layout.ts";
import type { RenderTheme } from "../../shared/rendering/theme.ts";
import type { SendMessageViewModel } from "./send-message-view-model.ts";

export function buildSendMessagePresentation(
  model: SendMessageViewModel,
  theme: RenderTheme,
): ExpandableContentPresentation {
  const target =
    model.status === "delivered"
      ? (model.targetSessionName ?? model.targetSessionId)
      : (model.targetSessionId ?? "[target pending]");
  const metadata = [
    model.relation,
    model.requestResponse ? "response requested" : undefined,
  ].filter((item): item is string => Boolean(item));
  const metadataHint = metadata.length > 0 ? ` (${metadata.join(", ")})` : "";
  const action = model.status === "delivered" ? "delivered to" : "to";

  return {
    header: `${theme.fg("toolTitle", theme.bold("session_send_message"))} ${theme.fg(
      "muted",
      `${action} ${target}${metadataHint}`,
    )}`,
    ...(model.status === "delivered"
      ? {
          expandedMetadata: [`${theme.bold("session")} ${model.targetSessionId}`],
        }
      : {}),
    ...(model.body
      ? {
          body: {
            text: theme.fg("toolOutput", model.body.replaceAll("\t", "  ")),
            collapsedRows: 3,
          },
        }
      : {}),
  };
}
