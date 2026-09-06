import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  type Focusable,
  matchesKey,
  type TuiMouseEvent,
  type TuiMouseEventResult,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { type LegendHit, LegendPointer, layoutLegend, legendHitAt } from "../shared/legend.ts";
import type { SessionIndexStatus } from "../shared/session-index/index.ts";

export type SessionIndexAction = "reindex" | undefined;

export class SessionIndexPanel implements Focusable {
  focused = false;
  private actionRows = new Map<number, LegendHit[]>();
  private readonly pointer: LegendPointer;

  constructor(
    private readonly theme: Theme,
    private readonly status: SessionIndexStatus,
    private readonly done: (result: SessionIndexAction) => void,
    requestRender: () => void,
  ) {
    this.pointer = new LegendPointer(requestRender);
  }

  invalidate(): void {}

  handleInput(data: string): void {
    if (matchesKey(data, "escape") || matchesKey(data, "enter")) {
      this.done(undefined);
    } else if (data === "r" || data === "R" || matchesKey(data, "r")) {
      this.done("reindex");
    }
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const result = this.pointer.handleMouse(
      event,
      legendHitAt(this.actionRows.get(event.y) ?? [], event.x - 2),
    );
    return event.type === "press" && result?.handled ? { ...result, focus: true } : result;
  }

  render(width: number): string[] {
    this.actionRows.clear();
    const innerWidth = Math.max(0, Math.min(72, width) - 2);
    const lines: string[] = [this.theme.fg("border", `╭${"─".repeat(innerWidth)}╮`)];
    lines.push(
      this.renderRow(innerWidth, ` ${this.theme.bold(this.theme.fg("accent", "Session Index"))}`),
    );
    lines.push(this.renderRow(innerWidth, ""));
    lines.push(
      this.renderRow(
        innerWidth,
        ` Path: ${this.status.exists ? this.status.dbPath : "<no index found>"}`,
      ),
    );
    lines.push(
      this.renderRow(
        innerWidth,
        ` Schema version: ${this.status.schemaVersion !== undefined ? String(this.status.schemaVersion) : "n/a"}`,
      ),
    );
    lines.push(
      this.renderRow(
        innerWidth,
        ` Session count: ${this.status.sessionCount !== undefined ? String(this.status.sessionCount) : "n/a"}`,
      ),
    );
    lines.push(
      this.renderRow(innerWidth, ` Last full reindex: ${this.status.lastFullReindexAt ?? "n/a"}`),
    );
    lines.push(this.renderRow(innerWidth, ""));
    this.renderAction(lines, innerWidth, "R", "rebuild from disk", () => this.done("reindex"));
    this.renderAction(lines, innerWidth, "Enter / Esc", "close", () => this.done(undefined));
    lines.push(this.theme.fg("border", `╰${"─".repeat(innerWidth)}╯`));
    return lines;
  }

  private renderAction(
    lines: string[],
    innerWidth: number,
    key: string,
    description: string,
    run: () => void,
  ): void {
    const legend = layoutLegend(this.theme, [{ key, description, run }], {
      width: Math.max(0, innerWidth - 1),
      pressedId: this.pointer.pressedId,
    });
    this.actionRows.set(lines.length, legend.hits);
    lines.push(this.renderRow(innerWidth, ` ${legend.text}`));
  }

  private renderRow(innerWidth: number, content: string): string {
    const text = truncateToWidth(content, innerWidth, "…");
    const pad = Math.max(0, innerWidth - visibleWidth(text));
    return `${this.theme.fg("border", "│")}${text}${" ".repeat(pad)}${this.theme.fg("border", "│")}`;
  }
}
