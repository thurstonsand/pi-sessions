import type { ExpandableContentPresentation } from "../../shared/rendering/expandable-content-layout.ts";
import type { RenderTheme } from "../../shared/rendering/theme.ts";
import type { IncomingMessageViewModel } from "./incoming-message-view-model.ts";

export function buildIncomingMessagePresentation(
  model: IncomingMessageViewModel,
  theme: RenderTheme,
): ExpandableContentPresentation {
  const source = model.sourceSessionName
    ? `${model.sourceSessionName} (${model.sourceSessionId})`
    : model.sourceSessionId;
  const metadata = [
    model.relation,
    model.requestResponse ? "response requested" : undefined,
  ].filter((item): item is string => Boolean(item));
  const metadataHint = metadata.length > 0 ? ` (${metadata.join(", ")})` : "";

  return {
    header: `${theme.fg("toolTitle", theme.bold("incoming_message"))} ${theme.fg(
      "muted",
      `from ${source}${metadataHint}`,
    )}`,
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
