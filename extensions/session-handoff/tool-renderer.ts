import type { KeybindingHints, Theme } from "@earendil-works/pi-coding-agent";
import { type Component, Container, Spacer, Text } from "@earendil-works/pi-tui";
import { ExpandableContentLayout } from "../shared/rendering/expandable-content-layout.ts";
import type { ClipboardStatus } from "./launch/backend.ts";
import { createLaunchCommandComponent, formatDeferredCommandLabel } from "./receipt.ts";
import { buildHandoffToolPresentation } from "./tool-presenter.ts";
import type { HandoffToolViewModel } from "./tool-view-model.ts";

export class HandoffToolComponent implements Component {
  private model: HandoffToolViewModel | undefined;
  private clipboardStatus: ClipboardStatus | undefined;
  private readonly layout: ExpandableContentLayout;
  private rendered: { width: number; lines: readonly string[] } | undefined;

  constructor(
    private readonly theme: Theme,
    keyText: KeybindingHints["keyText"],
  ) {
    this.layout = new ExpandableContentLayout(theme, keyText);
  }

  update(
    model: HandoffToolViewModel,
    expanded: boolean,
    clipboardStatus?: ClipboardStatus | undefined,
  ): void {
    this.model = model;
    this.clipboardStatus = clipboardStatus;
    this.rendered = undefined;
    this.layout.update(buildHandoffToolPresentation(model, this.theme), expanded);
  }

  invalidate(): void {
    this.rendered = undefined;
    this.layout.invalidate();
  }

  render(width: number): readonly string[] {
    if (!this.model) {
      return [];
    }
    if (this.rendered?.width === width) {
      return this.rendered.lines;
    }

    const container = new Container();
    container.addChild(this.layout);
    const result = this.model.result;
    // Only a deferred handoff needs its command in the transcript, because the
    // user is the one who has to run it. A launched child is already running;
    // the board is where its command belongs.
    if (result?.launch === "deferred") {
      container.addChild(new Spacer(1));
      container.addChild(
        createLaunchCommandComponent(
          result.resumeCommand,
          formatDeferredCommandLabel(this.clipboardStatus),
          this.theme,
        ),
      );
    }
    if (result?.degradedFrom) {
      container.addChild(new Spacer(1));
      container.addChild(
        new Text(
          this.theme.fg("muted", `(requested ${result.degradedFrom}; split backend unavailable)`),
          0,
          0,
        ),
      );
    }
    const lines = container.render(width);
    this.rendered = { width, lines };
    return lines;
  }
}
