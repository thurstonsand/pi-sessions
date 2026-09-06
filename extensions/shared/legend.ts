import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  type TuiMouseEvent,
  type TuiMouseEventResult,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";

export interface LegendItem {
  key: string;
  description: string;
  run?: () => void;
}

export interface LegendHit {
  id: string;
  start: number;
  end: number;
  run: () => void;
}

export interface LegendLine {
  text: string;
  hits: LegendHit[];
}

export function layoutLegend(
  theme: Theme,
  items: LegendItem[],
  options: { width: number; trailing?: string; separator?: string; pressedId?: string | undefined },
): LegendLine {
  const separator = options.separator ?? "  ";
  const parts: Array<{ text: string; hit: LegendHit | undefined }> = [];
  const hits: LegendHit[] = [];
  let column = 0;
  for (const item of items) {
    if (parts.length > 0) {
      parts.push({ text: separator, hit: undefined });
      column += visibleWidth(separator);
    }
    const end = column + visibleWidth(item.key) + 1 + visibleWidth(item.description);
    const hit = item.run
      ? { id: `${item.key} ${item.description}`, start: column, end, run: item.run }
      : undefined;
    if (hit) hits.push(hit);
    parts.push({
      text: theme.fg("dim", item.key) + theme.fg("muted", ` ${item.description}`),
      hit,
    });
    column = end;
  }
  const trailing = options.trailing ? theme.fg("dim", options.trailing) : "";
  const suffix = trailing
    ? `${" ".repeat(Math.max(1, options.width - column - visibleWidth(trailing)))}${trailing}`
    : "";
  const clipped = column + visibleWidth(suffix) > options.width;
  const visibleEnd = options.width - (clipped ? 1 : 0);
  const text =
    parts
      .map(({ text, hit }) =>
        hit && hit.end <= visibleEnd && hit.id === options.pressedId
          ? theme.bg("selectedBg", text)
          : text,
      )
      .join("") + suffix;
  return {
    text: truncateToWidth(text, options.width, "…"),
    hits: hits.filter((hit) => hit.end <= visibleEnd),
  };
}

export class LegendPointer {
  private pressed: LegendHit | undefined;
  private down = false;

  constructor(private readonly requestRender: () => void) {}

  get pressedId(): string | undefined {
    return this.down ? this.pressed?.id : undefined;
  }

  handleMouse(event: TuiMouseEvent, hit: LegendHit | undefined): TuiMouseEventResult | undefined {
    if (event.type === "press") {
      const wasDown = this.down;
      this.pressed = event.button === "left" ? hit : undefined;
      this.down = this.pressed !== undefined;
      if (this.down) return { handled: true };
      if (wasDown) this.requestRender();
      return undefined;
    }
    if (event.button !== "left") return undefined;
    if (event.type === "drag" && this.pressed) {
      this.pressed = undefined;
      this.down = false;
      return { handled: true };
    }
    if (event.type === "release" && this.pressed) {
      this.down = false;
      return { handled: true, render: true };
    }
    if (event.type === "click") {
      // Release clears the highlight, not the action: Pi delivers click afterward using press-time coordinates.
      const action = this.pressed;
      this.pressed = undefined;
      this.down = false;
      if (!action) return undefined;
      action.run();
      return { handled: true };
    }
    return undefined;
  }
}

export function legendHitAt(hits: LegendHit[], column: number): LegendHit | undefined {
  return hits.find((hit) => column >= hit.start && column < hit.end);
}
