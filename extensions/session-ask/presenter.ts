import type { ExpandableContentPresentation } from "../shared/rendering/expandable-content-layout.ts";
import type { RenderTheme } from "../shared/rendering/theme.ts";
import { formatSessionTitleOrShortId } from "../shared/session-ui.ts";
import type { SessionAskViewModel } from "./view-model.ts";

export function buildSessionAskPresentation(
  model: SessionAskViewModel,
  theme: RenderTheme,
): ExpandableContentPresentation {
  const identity = formatSessionTitleOrShortId(model.sessionName, model.sessionId);
  return {
    header: `title: ${theme.bold(identity)}`,
    ...(model.question
      ? {
          metadata: [theme.fg("muted", `prompt: ${model.question}`)],
        }
      : {}),
    body: {
      text: model.answer,
      collapsedRows: 6,
    },
  };
}
