import type { KeybindingHints } from "@earendil-works/pi-coding-agent";
import { type Component, Container, Spacer, Text, wrapTextWithAnsi } from "@earendil-works/pi-tui";
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
  private rendered: { width: number; lines: readonly string[] } | undefined;

  constructor(
    private readonly theme: RenderTheme,
    private readonly keyText: KeybindingHints["keyText"],
  ) {}

  update(presentation: ExpandableContentPresentation, expanded: boolean): void {
    this.presentation = presentation;
    this.expanded = expanded;
    this.rendered = undefined;

    if (!presentation.body) {
      this.body = undefined;
      this.bodyRows = undefined;
      return;
    }

    if (!this.body || this.bodyRows !== presentation.body.collapsedRows) {
      this.body = new CollapsibleText({
        collapsedRows: presentation.body.collapsedRows,
        theme: this.theme,
        keyText: this.keyText,
      });
      this.bodyRows = presentation.body.collapsedRows;
    }
    this.body.setText(presentation.body.text);
    this.body.setExpanded(expanded);
  }

  invalidate(): void {
    this.rendered = undefined;
    this.body?.invalidate();
  }

  render(width: number): readonly string[] {
    if (!this.presentation) {
      return [];
    }
    if (this.rendered?.width === width) {
      return this.rendered.lines;
    }

    const container = new Container();
    container.addChild(new Text(this.presentation.header, 0, 0));

    const visibleMetadata = this.presentation.metadata ?? [];
    const expandedMetadata = this.presentation.expandedMetadata ?? [];
    const metadata = [...visibleMetadata, ...(this.expanded ? expandedMetadata : [])];
    if (metadata.length > 0) {
      container.addChild(new Text(metadata.join("\n"), 0, 0));
    }

    if (this.body && this.presentation.body?.text) {
      this.body.setSupplementalRowCounts(
        countRenderedRows(visibleMetadata, width),
        countRenderedRows(expandedMetadata, width),
      );
      const spacingBefore = this.presentation.body.spacingBefore ?? 1;
      if (spacingBefore > 0) {
        container.addChild(new Spacer(spacingBefore));
      }
      container.addChild(this.body);
    }
    const lines = container.render(width);
    this.rendered = { width, lines };
    return lines;
  }
}

function countRenderedRows(lines: readonly string[], width: number): number {
  const renderWidth = Math.max(1, width);
  return lines.reduce((total, line) => total + wrapTextWithAnsi(line, renderWidth).length, 0);
}
