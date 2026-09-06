import type { ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import {
  type Focusable,
  Input,
  type KeyId,
  matchesKey,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { type LegendHit, LegendPointer, layoutLegend, legendHitAt } from "../shared/legend.ts";
import {
  stripSearchSnippetMarkers,
  transformSearchSnippetMatches,
} from "../shared/search-snippet.ts";
import { listSessionPickerItems, normalizeDisplayText, type SessionPickerItem } from "./query.ts";

const MAX_VISIBLE_BROWSE_ROWS = 10;
const MAX_VISIBLE_SEARCH_ROWS = 4;
const SEARCH_RELOAD_DEBOUNCE_MS = 200;

interface PickerRightColumnWidths {
  marker: number;
  messageCount: number;
  modifiedAt: number;
}

interface PickerSessionHit {
  row: number;
  end: number;
  sessionId: string;
}

export type SessionPickerResult =
  | { kind: "cancel" }
  | { kind: "insert-session-token"; sessionId: string };

export async function openSessionReferencePicker(
  ctx: ExtensionContext,
  indexPath: string,
  shortcut: KeyId,
): Promise<SessionPickerResult> {
  return ctx.ui.custom<SessionPickerResult>(
    (tui, theme, keybindings, done) =>
      new SessionReferencePickerComponent(tui, theme, keybindings, done, {
        indexPath,
        shortcut,
        getCurrentSessionPath: () => ctx.sessionManager.getSessionFile(),
        getCurrentCwd: () => ctx.cwd,
      }),
    {
      overlay: true,
      overlayOptions: {
        anchor: "bottom-center",
        width: "100%",
        maxHeight: 18,
        margin: { left: 1, right: 1, bottom: 1 },
      },
    },
  );
}

interface SessionReferencePickerOptions {
  indexPath: string;
  shortcut: KeyId;
  getCurrentSessionPath: () => string | undefined;
  getCurrentCwd: () => string | undefined;
}

export class SessionReferencePickerComponent implements Focusable {
  private _focused = false;
  private readonly input = new Input();
  private includeAll = false;
  private items: SessionPickerItem[] = [];
  private selectedIndex = 0;
  private sessionHits: PickerSessionHit[] = [];
  private actionRows = new Map<number, LegendHit[]>();
  private inputBounds: { row: number; width: number } | undefined;
  private pressedSessionId: string | undefined;
  private readonly legendPointer = new LegendPointer(() => this.tui.requestRender());
  private searchReloadTimer: ReturnType<typeof setTimeout> | undefined;

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.input.focused = value;
  }

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly keybindings: KeybindingsManager,
    private readonly done: (result: SessionPickerResult) => void,
    private readonly options: SessionReferencePickerOptions,
  ) {
    this.reload();
  }

  invalidate(): void {}

  handleInput(data: string): void {
    if (matchesKey(data, this.options.shortcut)) {
      this.finish({ kind: "cancel" });
      return;
    }

    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.finish({ kind: "cancel" });
      return;
    }

    if (this.keybindings.matches(data, "tui.input.tab")) {
      this.setScope(!this.includeAll);
      return;
    }

    if (this.keybindings.matches(data, "tui.select.up")) {
      this.moveSelection(-1);
      this.tui.requestRender();
      return;
    }

    if (this.keybindings.matches(data, "tui.select.down")) {
      this.moveSelection(1);
      this.tui.requestRender();
      return;
    }

    if (this.keybindings.matches(data, "tui.select.pageUp")) {
      this.moveSelection(-this.getMaxVisibleRows());
      this.tui.requestRender();
      return;
    }

    if (this.keybindings.matches(data, "tui.select.pageDown")) {
      this.moveSelection(this.getMaxVisibleRows());
      this.tui.requestRender();
      return;
    }

    if (this.keybindings.matches(data, "tui.select.confirm")) {
      this.confirmSelection();
      return;
    }

    const before = this.input.getValue();
    this.input.handleInput(data);
    if (this.input.getValue() !== before) {
      this.reloadAfterInputChange();
      this.tui.requestRender();
    }
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type === "press") this.pressedSessionId = undefined;
    const action =
      event.type === "press"
        ? legendHitAt(this.actionRows.get(event.y) ?? [], event.x - 1)
        : undefined;
    const legend = this.legendPointer.handleMouse(event, action);
    if (legend) return event.type === "press" ? { ...legend, focus: true } : legend;
    if (event.type === "press") {
      if (event.button !== "left") return undefined;
      const session = this.sessionAt(event);
      if (session) {
        this.pressedSessionId = session.sessionId;
        const index = this.items.findIndex(
          (item) => item.kind === "session" && item.sessionId === session.sessionId,
        );
        if (index >= 0) this.selectedIndex = index;
        return { handled: true, focus: true };
      }
      return undefined;
    }
    if (event.type === "wheel" && event.wheelDelta && this.sessionAt(event)) {
      this.moveSelection(event.wheelDelta < 0 ? -1 : 1);
      return { handled: true };
    }
    if (event.type !== "click" || event.button !== "left") return undefined;
    const sessionId = this.pressedSessionId;
    this.pressedSessionId = undefined;
    if (sessionId) {
      this.finish({ kind: "insert-session-token", sessionId });
      return { handled: true };
    }
    const input = this.inputBounds;
    if (input && event.y === input.row && event.x >= 1 && event.x < input.width + 1) {
      // Input places its cursor on press; defer that call until click so text drags stay unhandled.
      return this.input.handleMouse({
        ...event,
        type: "press",
        x: event.x - 1,
        y: 0,
        width: input.width,
        height: 1,
      });
    }
    return undefined;
  }

  private sessionAt(event: TuiMouseEvent): PickerSessionHit | undefined {
    return this.sessionHits.find((hit) => hit.row === event.y && event.x >= 1 && event.x < hit.end);
  }

  private setScope(includeAll: boolean): void {
    this.includeAll = includeAll;
    this.cancelSearchReload();
    this.reload();
    this.tui.requestRender();
  }

  private confirmSelection(): void {
    this.flushSearchReload();
    const selected = this.items[this.selectedIndex];
    if (selected?.kind === "session") {
      this.finish({ kind: "insert-session-token", sessionId: selected.sessionId });
    }
  }

  render(width: number): string[] {
    this.sessionHits = [];
    this.actionRows.clear();
    this.inputBounds = undefined;
    const panelWidth = Math.max(0, width);
    const innerWidth = Math.max(0, panelWidth - 2);
    const folder = this.theme.fg(
      this.includeAll ? "muted" : "accent",
      `${this.includeAll ? "○" : "◉"} Current Folder`,
    );
    const all = this.theme.fg(
      this.includeAll ? "accent" : "muted",
      `${this.includeAll ? "◉" : "○"} All`,
    );
    const separator = this.theme.fg("muted", " | ");
    const scopeText = `${folder}${separator}${all}`;
    const title = this.theme.bold("Add Session Reference to Prompt");
    const titleWidth = Math.max(0, innerWidth - visibleWidth(scopeText) - 1);
    const titleText = truncateToWidth(title, titleWidth, "…", true);
    const headerSpacing = Math.max(
      0,
      innerWidth - visibleWidth(titleText) - visibleWidth(scopeText),
    );

    const lines = [this.theme.fg("border", `╭${"─".repeat(innerWidth)}╮`)];
    const scopeStart = visibleWidth(titleText) + headerSpacing;
    if (scopeStart + visibleWidth(scopeText) <= innerWidth) {
      const folderEnd = scopeStart + visibleWidth(folder);
      const allStart = folderEnd + visibleWidth(separator);
      this.actionRows.set(1, [
        { id: "scope:folder", start: scopeStart, end: folderEnd, run: () => this.setScope(false) },
        {
          id: "scope:all",
          start: allStart,
          end: allStart + visibleWidth(all),
          run: () => this.setScope(true),
        },
      ]);
    }
    const shownFolder =
      this.actionRows.has(1) && this.legendPointer.pressedId === "scope:folder"
        ? this.theme.bg("selectedBg", folder)
        : folder;
    const shownAll =
      this.actionRows.has(1) && this.legendPointer.pressedId === "scope:all"
        ? this.theme.bg("selectedBg", all)
        : all;
    lines.push(
      this.renderRow(
        `${titleText}${" ".repeat(headerSpacing)}${shownFolder}${separator}${shownAll}`,
        innerWidth,
      ),
    );
    const selected = this.items[this.selectedIndex];
    const legend = layoutLegend(
      this.theme,
      [
        {
          key: "enter",
          description: "add to prompt",
          run: () => {
            if (selected?.kind === "session") {
              this.finish({ kind: "insert-session-token", sessionId: selected.sessionId });
            }
          },
        },
        { key: "esc", description: "cancel", run: () => this.finish({ kind: "cancel" }) },
        { key: "tab", description: "scope", run: () => this.setScope(!this.includeAll) },
      ],
      { width: innerWidth, separator: " · ", pressedId: this.legendPointer.pressedId },
    );
    this.actionRows.set(lines.length, legend.hits);
    lines.push(this.renderRow(legend.text, innerWidth));
    lines.push(this.renderRow("", innerWidth));

    this.inputBounds = { row: lines.length, width: innerWidth };
    for (const inputLine of this.input.render(innerWidth)) {
      lines.push(this.renderRow(inputLine, innerWidth));
    }

    lines.push(this.renderRow("", innerWidth));

    const visibleItems = this.getVisibleItems();
    const rightWidths = this.getRightColumnWidths();
    for (const { item, index } of visibleItems) {
      lines.push(
        ...this.renderPickerItem(
          item,
          index === this.selectedIndex,
          innerWidth,
          rightWidths,
          lines.length,
        ),
      );
    }

    if (visibleItems.length === 0) {
      lines.push(this.renderRow(this.theme.fg("muted", "No sessions"), innerWidth));
    }

    const sessionCount = this.items.filter((item) => item.kind === "session").length;
    if (sessionCount > 0) {
      lines.push(
        this.renderRow(
          this.theme.fg("muted", `(${this.selectedIndex + 1}/${sessionCount})`),
          innerWidth,
        ),
      );
    }

    lines.push(this.theme.fg("border", `╰${"─".repeat(innerWidth)}╯`));
    return lines;
  }

  private renderPickerItem(
    item: SessionPickerItem,
    selected: boolean,
    innerWidth: number,
    rightWidths: PickerRightColumnWidths,
    firstRow: number,
  ): string[] {
    if (item.kind !== "session") {
      const message = [item.title, item.description].filter(Boolean).join(" — ");
      return [
        this.renderRow(
          this.theme.fg(item.kind === "error" ? "error" : "muted", message),
          innerWidth,
        ),
      ];
    }

    const cursor = selected ? `${this.theme.fg("accent", "›")} ` : "  ";
    const right = this.renderRightMetadata(item, rightWidths);
    const highlightedTitle = this.formatTitleHighlight(item.title, item.snippet);
    const leftText = `${item.prefix}${highlightedTitle ?? item.title}`;
    const available = Math.max(8, innerWidth - 2 - visibleWidth(cursor) - visibleWidth(right) - 1);
    const left = truncateToWidth(leftText, available, "…", true);
    const spacing = Math.max(
      1,
      innerWidth - 2 - visibleWidth(cursor) - visibleWidth(left) - visibleWidth(right),
    );
    const titleLine = `${cursor}${left}${" ".repeat(spacing)}${right}`;
    const lines = [
      this.renderSelectableRow(titleLine, innerWidth, selected, firstRow, item.sessionId),
    ];

    if (item.snippet && !highlightedTitle) {
      const snippet = this.formatSnippet(
        item.snippet,
        Math.max(8, innerWidth - 2 - visibleWidth(cursor)),
      );
      if (snippet) {
        lines.push(
          this.renderSelectableRow(
            `  ${this.theme.fg("dim", snippet)}`,
            innerWidth,
            selected,
            firstRow + lines.length,
            item.sessionId,
          ),
        );
      }
    }

    return lines;
  }

  private renderRow(content: string, innerWidth: number): string {
    content = truncateToWidth(content, innerWidth, "…");
    const pad = Math.max(0, innerWidth - visibleWidth(content));
    return `${this.theme.fg("border", "│")}${content}${" ".repeat(pad)}${this.theme.fg("border", "│")}`;
  }

  private renderSelectableRow(
    content: string,
    innerWidth: number,
    selected: boolean,
    row: number,
    sessionId: string,
  ): string {
    this.sessionHits.push({ row, end: 1 + Math.min(innerWidth, visibleWidth(content)), sessionId });
    return this.renderRow(selected ? this.theme.bg("selectedBg", content) : content, innerWidth);
  }

  private formatTitleHighlight(title: string, snippet?: string | undefined): string | undefined {
    if (!snippet) {
      return undefined;
    }

    const plainSnippet = normalizeDisplayText(stripSearchSnippetMarkers(snippet));
    if (!plainSnippet || plainSnippet !== normalizeDisplayText(title)) {
      return undefined;
    }

    return this.highlightSnippetMatches(snippet);
  }

  private formatSnippet(snippet: string, maxWidth: number): string | undefined {
    const rendered = this.highlightSnippetMatches(snippet);
    if (!rendered) {
      return undefined;
    }

    return truncateToWidth(rendered, maxWidth, "…");
  }

  private highlightSnippetMatches(snippet: string): string | undefined {
    return transformSearchSnippetMatches(snippet, (match) =>
      this.theme.fg("accent", this.theme.bold(match)),
    )
      ?.replace(/\s+/g, " ")
      .trim();
  }

  private reloadAfterInputChange(): void {
    if (!this.input.getValue().trim()) {
      this.cancelSearchReload();
      this.reload();
      return;
    }

    this.scheduleSearchReload();
  }

  private scheduleSearchReload(): void {
    this.cancelSearchReload();
    this.searchReloadTimer = setTimeout(() => {
      this.searchReloadTimer = undefined;
      this.reload();
      this.tui.requestRender();
    }, SEARCH_RELOAD_DEBOUNCE_MS);
  }

  private flushSearchReload(): void {
    if (!this.searchReloadTimer) {
      return;
    }

    this.cancelSearchReload();
    this.reload();
  }

  private cancelSearchReload(): void {
    if (!this.searchReloadTimer) {
      return;
    }

    clearTimeout(this.searchReloadTimer);
    this.searchReloadTimer = undefined;
  }

  private finish(result: SessionPickerResult): void {
    this.cancelSearchReload();
    this.done(result);
  }

  private reload(): void {
    this.items = listSessionPickerItems({
      currentSessionPath: this.options.getCurrentSessionPath(),
      currentCwd: this.options.getCurrentCwd(),
      includeAll: this.includeAll,
      indexPath: this.options.indexPath,
      mode: this.input.getValue().trim() ? "search" : "browse",
      query: this.input.getValue(),
    }).items;
    this.selectedIndex = this.getFirstSessionIndex();
    this.input.focused = this.focused;
  }

  private getFirstSessionIndex(): number {
    const firstIndex = this.items.findIndex((item) => item.kind === "session");
    return firstIndex >= 0 ? firstIndex : 0;
  }

  private moveSelection(delta: number): void {
    const sessionIndexes = this.items
      .map((item, index) => (item.kind === "session" ? index : -1))
      .filter((index) => index >= 0);
    if (sessionIndexes.length === 0) {
      return;
    }

    const currentSessionListIndex = Math.max(0, sessionIndexes.indexOf(this.selectedIndex));
    const nextSessionListIndex = Math.max(
      0,
      Math.min(sessionIndexes.length - 1, currentSessionListIndex + delta),
    );
    this.selectedIndex = sessionIndexes[nextSessionListIndex] ?? this.selectedIndex;
  }

  private renderRightMetadata(
    item: Extract<SessionPickerItem, { kind: "session" }>,
    widths: PickerRightColumnWidths,
  ): string {
    const marker = padEndToWidth(item.marker, widths.marker);
    const messageCount = padStartToWidth(String(item.messageCount), widths.messageCount);
    const modifiedAt = padStartToWidth(item.modifiedAtText ?? "", widths.modifiedAt);
    const plain =
      widths.modifiedAt > 0
        ? `${marker} · ${messageCount} ${modifiedAt}`
        : `${marker} · ${messageCount}`;
    return this.theme.fg("dim", plain);
  }

  private getRightColumnWidths(): PickerRightColumnWidths {
    const sessionItems = this.items.filter(
      (item): item is Extract<SessionPickerItem, { kind: "session" }> => item.kind === "session",
    );
    return {
      marker: Math.max(0, ...sessionItems.map((item) => visibleWidth(item.marker))),
      messageCount: Math.max(
        0,
        ...sessionItems.map((item) => visibleWidth(String(item.messageCount))),
      ),
      modifiedAt: Math.max(
        0,
        ...sessionItems.map((item) => visibleWidth(item.modifiedAtText ?? "")),
      ),
    };
  }

  private getVisibleItems(): Array<{ item: SessionPickerItem; index: number }> {
    const maxVisibleRows = this.getMaxVisibleRows();
    if (this.items.length <= maxVisibleRows) {
      return this.items.map((item, index) => ({ item, index }));
    }

    const sessionIndexes = this.items
      .map((item, index) => (item.kind === "session" ? index : -1))
      .filter((index) => index >= 0);
    const currentSessionListIndex = Math.max(0, sessionIndexes.indexOf(this.selectedIndex));
    const startSessionListIndex = Math.max(
      0,
      Math.min(
        currentSessionListIndex - Math.floor(maxVisibleRows / 2),
        Math.max(0, sessionIndexes.length - maxVisibleRows),
      ),
    );
    const endSessionListIndex = Math.min(
      sessionIndexes.length,
      startSessionListIndex + maxVisibleRows,
    );
    const visibleIndexes = new Set(
      sessionIndexes.slice(startSessionListIndex, endSessionListIndex),
    );
    return this.items
      .map((item, index) => ({ item, index }))
      .filter(({ item, index }) => item.kind !== "session" || visibleIndexes.has(index));
  }

  private getMaxVisibleRows(): number {
    return this.input.getValue().trim() ? MAX_VISIBLE_SEARCH_ROWS : MAX_VISIBLE_BROWSE_ROWS;
  }
}

function padStartToWidth(value: string, width: number): string {
  const pad = Math.max(0, width - visibleWidth(value));
  return `${" ".repeat(pad)}${value}`;
}

function padEndToWidth(value: string, width: number): string {
  const pad = Math.max(0, width - visibleWidth(value));
  return `${value}${" ".repeat(pad)}`;
}
