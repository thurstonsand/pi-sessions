import { type Component, Container, Spacer, Text } from "@earendil-works/pi-tui";
import { CollapsibleText } from "./collapsible-text.ts";
import type { RenderTheme } from "./theme.ts";

export interface ExpandableContentPresentation {
  header: string;
  metadata?: string[] | undefined;
  expandedMetadata?: string[] | undefined;
  body?:
    | {
        text: string;
        collapsedRows: number;
        spacingBefore?: number | undefined;
      }
    | undefined;
}

export class ExpandableContentLayout implements Component {
  private presentation: ExpandableContentPresentation | undefined;
  private expanded = false;
  private body: CollapsibleText | undefined;
  private bodyRows: number | undefined;

  constructor(private readonly theme: RenderTheme) {}

  update(presentation: ExpandableContentPresentation, expanded: boolean): void {
    this.presentation = presentation;
    this.expanded = expanded;

    if (!presentation.body) {
      this.body = undefined;
      this.bodyRows = undefined;
      return;
    }

    if (!this.body || this.bodyRows !== presentation.body.collapsedRows) {
      this.body = new CollapsibleText({
        collapsedRows: presentation.body.collapsedRows,
        theme: this.theme,
      });
      this.bodyRows = presentation.body.collapsedRows;
    }
    this.body.setText(presentation.body.text);
    this.body.setExpanded(expanded);
  }

  invalidate(): void {
    this.body?.invalidate();
  }

  render(width: number): string[] {
    if (!this.presentation) {
      return [];
    }

    const container = new Container();
    container.addChild(new Text(this.presentation.header, 0, 0));

    const metadata = [
      ...(this.presentation.metadata ?? []),
      ...(this.expanded ? (this.presentation.expandedMetadata ?? []) : []),
    ];
    if (metadata.length > 0) {
      container.addChild(new Text(metadata.join("\n"), 0, 0));
    }

    if (this.body && this.presentation.body?.text) {
      const spacingBefore = this.presentation.body.spacingBefore ?? 1;
      if (spacingBefore > 0) {
        container.addChild(new Spacer(spacingBefore));
      }
      container.addChild(this.body);
    }
    return container.render(width);
  }
}
