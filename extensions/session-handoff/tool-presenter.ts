import type { ExpandableContentPresentation } from "../shared/rendering/expandable-content-layout.ts";
import type { RenderTheme } from "../shared/rendering/theme.ts";
import type { HandoffToolViewModel } from "./tool-view-model.ts";

const PENDING = "…";

export function buildHandoffToolPresentation(
  model: HandoffToolViewModel,
  theme: RenderTheme,
): ExpandableContentPresentation {
  const expandedMetadata: string[] = [];
  if (model.result) {
    expandedMetadata.push(`${theme.bold("session")} ${model.result.sessionId}`);
    expandedMetadata.push(`${theme.bold("model")} ${model.result.model}`);
    if (model.result.cwd) {
      expandedMetadata.push(`${theme.bold("cwd")} ${model.result.cwd}`);
    }
  }

  return {
    header: [
      theme.fg("accent", "session_handoff"),
      theme.fg("dim", `[${model.launch ?? PENDING}]`),
      theme.bold(model.title ?? PENDING),
    ].join(" "),
    ...(expandedMetadata.length > 0 ? { expandedMetadata } : {}),
    body: {
      text: `${theme.bold("goal")} ${model.goal ?? PENDING}`,
      collapsedRows: 1,
      spacingBefore: 0,
    },
  };
}
