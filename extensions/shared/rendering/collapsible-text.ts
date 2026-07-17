import {
  type Component,
  getKeybindings,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { RenderTheme } from "./theme.ts";

interface CollapsibleTextKeybindings {
  getKeys(keybinding: "app.tools.expand"): string[];
}

export interface CollapsibleTextOptions {
  collapsedRows: number;
  theme: RenderTheme;
  keybindings?: CollapsibleTextKeybindings | undefined;
}

export class CollapsibleText implements Component {
  private text = "";
  private expanded = false;
  private readonly collapsedRows: number;
  private readonly theme: RenderTheme;
  private readonly keybindings: CollapsibleTextKeybindings;

  constructor(options: CollapsibleTextOptions) {
    this.collapsedRows = Math.max(1, Math.floor(options.collapsedRows));
    this.theme = options.theme;
    this.keybindings = options.keybindings ?? getKeybindings();
  }

  setText(text: string): void {
    this.text = text;
  }

  setExpanded(expanded: boolean): void {
    this.expanded = expanded;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const renderWidth = Math.max(1, width);
    const rows = wrapTextWithAnsi(this.text, renderWidth);
    if (this.expanded || rows.length <= this.collapsedRows) {
      return rows.map((row) => padToWidth(row, renderWidth));
    }

    const remaining = rows.length - this.collapsedRows;
    const visibleRows = rows
      .slice(0, this.collapsedRows)
      .map((row) => padToWidth(row, renderWidth));
    const hintRows = wrapTextWithAnsi(
      this.formatExpandHint(remaining, rows.length),
      renderWidth,
    ).map((row) => padToWidth(row, renderWidth));
    return [...visibleRows, ...hintRows];
  }

  private formatExpandHint(remaining: number, total: number): string {
    const keys = this.keybindings.getKeys("app.tools.expand").join("/");
    if (!keys) {
      return this.theme.fg(
        "muted",
        `(${remaining} more lines, ${total} total, expand key unbound)`,
      );
    }
    return `${this.theme.fg("muted", `(${remaining} more lines, ${total} total, `)}${this.theme.fg(
      "dim",
      keys,
    )}${this.theme.fg("muted", " to expand)")}`;
  }
}

function padToWidth(text: string, width: number): string {
  return `${text}${" ".repeat(Math.max(0, width - visibleWidth(text)))}`;
}
