import {
  DynamicBorder,
  type KeybindingsManager,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Container,
  Loader,
  Spacer,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { type LegendHit, LegendPointer, layoutLegend, legendHitAt } from "../shared/legend.ts";

export class ReindexLoader implements Component {
  private readonly body = new Container();
  private readonly loader: Loader;
  private cancelRow = 0;
  private cancelHits: LegendHit[] = [];
  private readonly pointer: LegendPointer;

  constructor(
    tui: TUI,
    private readonly theme: Theme,
    private readonly keybindings: KeybindingsManager,
    private readonly cancel: () => void,
  ) {
    this.pointer = new LegendPointer(() => tui.requestRender());
    this.loader = new Loader(
      tui,
      (text) => theme.fg("accent", text),
      (text) => theme.fg("muted", text),
      "Rebuilding session index...",
    );
    this.body.addChild(new DynamicBorder((text) => theme.fg("border", text)));
    this.body.addChild(this.loader);
    this.body.addChild(new Spacer(1));
  }

  render(width: number): string[] {
    this.cancelHits = [];
    const lines = this.body.render(width);
    const legend = layoutLegend(
      this.theme,
      [
        {
          key: this.keybindings.getKeys("tui.select.cancel").join("/"),
          description: "cancel",
          run: this.cancel,
        },
      ],
      { width: Math.max(0, width - 2), pressedId: this.pointer.pressedId },
    );
    this.cancelRow = lines.length;
    this.cancelHits = legend.hits;
    lines.push(` ${legend.text}`, "", this.theme.fg("border", "─".repeat(Math.max(0, width))));
    return lines;
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    return this.pointer.handleMouse(
      event,
      event.y === this.cancelRow ? legendHitAt(this.cancelHits, event.x - 1) : undefined,
    );
  }

  handleInput(data: string): void {
    if (this.keybindings.matches(data, "tui.select.cancel")) this.cancel();
  }

  invalidate(): void {
    this.body.invalidate();
  }

  dispose(): void {
    this.loader.stop();
  }
}
