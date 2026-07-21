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
  private visibleSupplementalRows = 0;
  private hiddenSupplementalRows = 0;
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

  setSupplementalRowCounts(visibleRows: number, hiddenRows: number): void {
    this.visibleSupplementalRows = Math.max(0, Math.floor(visibleRows));
    this.hiddenSupplementalRows = Math.max(0, Math.floor(hiddenRows));
  }

  invalidate(): void {}

  render(width: number): string[] {
    const renderWidth = Math.max(1, width);
    const rows = wrapTextWithAnsi(this.text, renderWidth);
    if (this.expanded) {
      return rows.map((row) => padToWidth(row, renderWidth));
    }
    const hiddenBodyRows = Math.max(0, rows.length - this.collapsedRows);
    if (hiddenBodyRows === 0 && this.hiddenSupplementalRows === 0) {
      return rows.map((row) => padToWidth(row, renderWidth));
    }

    const remaining = hiddenBodyRows + this.hiddenSupplementalRows;
    const total = rows.length + this.visibleSupplementalRows + this.hiddenSupplementalRows;
    const visibleRows = rows
      .slice(0, this.collapsedRows)
      .map((row) => padToWidth(row, renderWidth));
    const hintRows = wrapTextWithAnsi(this.formatExpandHint(remaining, total), renderWidth).map(
      (row) => padToWidth(row, renderWidth),
    );
    return [...visibleRows, ...hintRows];
  }

  private formatExpandHint(remaining: number, total: number): string {
    const keys = this.keybindings.getKeys("app.tools.expand").join("/");
    const lineLabel = remaining === 1 ? "line" : "lines";
    if (!keys) {
      return this.theme.fg(
        "muted",
        `(${remaining} more ${lineLabel}, ${total} total, expand key unbound)`,
      );
    }
    return `${this.theme.fg("muted", `(${remaining} more ${lineLabel}, ${total} total, `)}${this.theme.fg(
      "dim",
      keys,
    )}${this.theme.fg("muted", " to expand)")}`;
  }
}

function padToWidth(text: string, width: number): string {
  return `${text}${" ".repeat(Math.max(0, width - visibleWidth(text)))}`;
}
