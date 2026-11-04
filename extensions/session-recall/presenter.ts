import type { ExpandableContentPresentation } from "../shared/rendering/expandable-content-layout.ts";
import type { RenderTheme } from "../shared/rendering/theme.ts";
import { formatSessionTitleOrShortId } from "../shared/session-ui.ts";
import type { SessionRecallViewModel } from "./view-model.ts";

export function buildSessionRecallPresentation(
  model: SessionRecallViewModel,
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
