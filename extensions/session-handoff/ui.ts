import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import {
  Key,
  matchesKey,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { type LegendHit, LegendPointer, layoutLegend, legendHitAt } from "../shared/legend.ts";
import { renderStrongModal } from "./strong-modal.ts";

export async function runHandoffTaskWithLoader<T>(
  ctx: { ui: ExtensionUIContext },
  label: string,
  task: (signal: AbortSignal) => Promise<T>,
): Promise<T | undefined> {
  let taskError: unknown;

  const result = await ctx.ui.custom<T | undefined>(
    (tui, theme, _keybindings, done) => {
      const abortController = new AbortController();
      let cancelHits: LegendHit[] = [];
      const pointer = new LegendPointer(() => tui.requestRender());
      const cancel = () => {
        abortController.abort();
        done(undefined);
        tui.requestRender();
      };

      task(abortController.signal)
        .then(done)
        .catch((error: unknown) => {
          if (!abortController.signal.aborted) {
            taskError = error;
          }
          done(undefined);
        });

      return {
        render(width: number): string[] {
          const legend = layoutLegend(
            theme,
            [{ key: "Esc", description: "to cancel.", run: cancel }],
            { width: Math.max(20, width - 4) - 6, pressedId: pointer.pressedId },
          );
          cancelHits = legend.hits;
          return renderStrongModal(
            [
              theme.fg("accent", theme.bold(label)),
              "",
              `${theme.fg("muted", "Press ")}${legend.text}`,
            ],
            width,
            theme,
          );
        },
        invalidate(): void {},
        handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
          return pointer.handleMouse(
            event,
            event.y === 3 ? legendHitAt(cancelHits, event.x - 8) : undefined,
          );
        },
        handleInput(data: string): void {
          if (matchesKey(data, Key.escape)) cancel();
        },
      };
    },
    {
      overlay: true,
      overlayOptions: {
        anchor: "center",
        width: "70%",
        maxHeight: "40%",
        margin: 2,
      },
    },
  );

  if (taskError) {
    throw taskError;
  }

  return result;
}

export function formatHandoffError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  return "Handoff generation failed.";
}
