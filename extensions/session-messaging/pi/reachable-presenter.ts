import type { ExpandableContentPresentation } from "../../shared/rendering/expandable-content-layout.ts";
import type { RenderTheme } from "../../shared/rendering/theme.ts";
import type {
  ReachableSessionRowViewModel,
  SessionReachableViewModel,
} from "./reachable-view-model.ts";

const COLLAPSED_ROW_COUNT = 6;

export function buildSessionReachablePresentation(
  model: SessionReachableViewModel,
  theme: RenderTheme,
): ExpandableContentPresentation {
  const header = theme.fg(
    "muted",
    `scope: ${model.scope} • ${formatSessionCount(model.rows.length)}`,
  );

  if (model.rows.length === 0) {
    return {
      header,
      metadata: [theme.fg("warning", formatEmptyText(model.scope))],
    };
  }

  return {
    header,
    body: {
      text: model.rows.map((row, index) => formatRow(row, index, theme)).join("\n"),
      collapsedRows: COLLAPSED_ROW_COUNT,
    },
  };
}

function formatRow(row: ReachableSessionRowViewModel, index: number, theme: RenderTheme): string {
  const annotations =
    row.annotations.length > 0 ? ` ${theme.fg("dim", `[${row.annotations.join(" • ")}]`)}` : "";
  const location = row.location ? ` ${theme.fg("dim", `(${row.location})`)}` : "";
  const heading = `${index + 1}. ${theme.bold(row.label)}${annotations}${location}`;
  return row.detail ? `${heading}\n${theme.fg("dim", `   ${row.detail}`)}` : heading;
}

function formatSessionCount(count: number): string {
  return count === 1 ? "1 session" : `${count} sessions`;
}

function formatEmptyText(scope: SessionReachableViewModel["scope"]): string {
  return scope === "user" ? "No other live sessions." : "No subagents launched from this session.";
}
