import type { Theme } from "@earendil-works/pi-coding-agent";
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

  constructor(private readonly theme: Theme) {
    this.layout = new ExpandableContentLayout(theme);
  }

  update(
    model: HandoffToolViewModel,
    expanded: boolean,
    clipboardStatus?: ClipboardStatus | undefined,
  ): void {
    this.model = model;
    this.clipboardStatus = clipboardStatus;
    this.layout.update(buildHandoffToolPresentation(model, this.theme), expanded);
  }

  invalidate(): void {
    this.layout.invalidate();
  }

  render(width: number): string[] {
    if (!this.model) {
      return [];
    }

    const container = new Container();
    container.addChild(this.layout);
    if (!this.model.result) {
      return container.render(width);
    }

    // Only a deferred handoff needs its command in the transcript, because the
    // user is the one who has to run it. A launched child is already running;
    // the board is where its command belongs.
    if (this.model.result.launch === "deferred") {
      container.addChild(new Spacer(1));
      container.addChild(
        createLaunchCommandComponent(
          this.model.result.resumeCommand,
          formatDeferredCommandLabel(this.clipboardStatus),
          this.theme,
        ),
      );
    }
    if (this.model.result.degradedFrom) {
      container.addChild(new Spacer(1));
      container.addChild(
        new Text(
          this.theme.fg(
            "muted",
            `(requested ${this.model.result.degradedFrom}; split backend unavailable)`,
          ),
          0,
          0,
        ),
      );
    }
    return container.render(width);
  }
}
