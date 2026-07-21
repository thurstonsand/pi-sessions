import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

export function renderStrongModal(lines: string[], width: number, theme: Theme): string[] {
  const innerWidth = Math.max(20, width - 4);
  const fillLine = (text: string) => {
    const truncated = truncateToWidth(text, innerWidth, "…", true);
    const padding = Math.max(0, innerWidth - visibleWidth(truncated));
    return theme.bg("customMessageBg", `  ${truncated}${" ".repeat(padding)}  `);
  };

  return ["", ...lines, ""].map(fillLine);
}
