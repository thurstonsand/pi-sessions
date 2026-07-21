import type { RenderTheme } from "../shared/rendering/theme.ts";
import type { SubagentReportMessageViewModel } from "./report-message-view-model.ts";

export function presentSubagentReportMessage(
  report: SubagentReportMessageViewModel,
  theme: RenderTheme,
): string {
  const status = report.status === "done" ? "" : `[${report.status}] `;
  const sections = [
    theme.fg("toolTitle", theme.bold(`Report from subagent ${status}“${report.title}”`)),
    presentSection("Summary", report.summary, theme),
  ];

  if (report.details) {
    sections.push(presentSection("Details", report.details, theme));
  }
  if (report.references.length > 0) {
    const references = report.references.map((reference) =>
      reference.description
        ? `- ${reference.reference} — ${reference.description}`
        : `- ${reference.reference}`,
    );
    sections.push(presentSection("References", references.join("\n"), theme));
  }
  if (report.nextSteps.length > 0) {
    sections.push(
      presentSection("Next steps", report.nextSteps.map((step) => `- ${step}`).join("\n"), theme),
    );
  }

  return sections.join("\n\n");
}

function presentSection(heading: string, body: string, theme: RenderTheme): string {
  return `${theme.fg("toolTitle", theme.bold(heading))}\n${theme.fg("toolOutput", body)}`;
}
