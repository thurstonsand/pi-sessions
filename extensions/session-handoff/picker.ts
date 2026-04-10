import type { ExtensionContext, KeybindingsManager, Theme } from "@mariozechner/pi-coding-agent";
import {
  type Focusable,
  Input,
  type KeyId,
  matchesKey,
  type TUI,
  truncateToWidth,
  visibleWidth,
} from "@mariozechner/pi-tui";
import { listSessionPickerItems, type SessionPickerItem } from "./query.js";

const MAX_VISIBLE_ROWS = 10;

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
      this.done({ kind: "cancel" });
      return;
    }

    if (this.keybindings.matches(data, "tui.select.cancel")) {
      this.done({ kind: "cancel" });
      return;
    }

    if (this.keybindings.matches(data, "tui.input.tab")) {
      this.includeAll = !this.includeAll;
      this.reload();
      this.tui.requestRender();
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
      this.moveSelection(-MAX_VISIBLE_ROWS);
      this.tui.requestRender();
      return;
    }

    if (this.keybindings.matches(data, "tui.select.pageDown")) {
      this.moveSelection(MAX_VISIBLE_ROWS);
      this.tui.requestRender();
      return;
    }

    if (this.keybindings.matches(data, "tui.select.confirm")) {
      const selected = this.items[this.selectedIndex];
      if (selected?.kind === "session") {
        this.done({ kind: "insert-session-token", sessionId: selected.sessionId });
      }
      return;
    }

    const before = this.input.getValue();
    this.input.handleInput(data);
    if (this.input.getValue() !== before) {
      this.reload();
      this.tui.requestRender();
    }
  }

  render(width: number): string[] {
    const panelWidth = Math.max(0, width);
    const innerWidth = Math.max(0, panelWidth - 2);
    const scopeText = this.includeAll
      ? `${this.theme.fg("muted", "○ Current Folder | ")}${this.theme.fg("accent", "◉ All")}`
      : `${this.theme.fg("accent", "◉ Current Folder")}${this.theme.fg("muted", " | ○ All")}`;
    const title = this.theme.bold("Add Session Reference to Prompt");
    const titleWidth = Math.max(0, innerWidth - visibleWidth(scopeText) - 1);
    const titleText = truncateToWidth(title, titleWidth, "…", true);
    const headerSpacing = Math.max(
      0,
      innerWidth - visibleWidth(titleText) - visibleWidth(scopeText),
    );

    const lines = [this.theme.fg("border", `╭${"─".repeat(innerWidth)}╮`)];
    lines.push(this.renderRow(`${titleText}${" ".repeat(headerSpacing)}${scopeText}`, innerWidth));
    lines.push(this.renderRow(this.theme.fg("muted", "plain text search"), innerWidth));
    lines.push(
      this.renderRow(
        this.theme.fg("muted", "enter add to prompt · esc cancel · tab scope"),
        innerWidth,
      ),
    );
    lines.push(this.renderRow("", innerWidth));

    for (const inputLine of this.input.render(innerWidth)) {
      lines.push(this.renderRow(inputLine, innerWidth));
    }

    lines.push(this.renderRow("", innerWidth));

    const visibleItems = this.getVisibleItems();
    for (const { item, index } of visibleItems) {
      lines.push(this.renderPickerItem(item, index === this.selectedIndex, innerWidth));
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

  private renderPickerItem(item: SessionPickerItem, selected: boolean, innerWidth: number): string {
    if (item.kind !== "session") {
      const message = [item.title, item.description].filter(Boolean).join(" — ");
      return this.renderRow(
        this.theme.fg(item.kind === "error" ? "error" : "muted", message),
        innerWidth,
      );
    }

    const cursor = selected ? `${this.theme.fg("accent", "›")} ` : "  ";
    const right = item.modifiedAtText
      ? `${item.marker} · ${item.messageCount} ${item.modifiedAtText}`
      : `${item.marker} · ${item.messageCount}`;
    const leftText = `${item.prefix}${item.title}`;
    const available = Math.max(8, innerWidth - 2 - visibleWidth(cursor) - visibleWidth(right) - 1);
    const left = truncateToWidth(leftText, available, "…", true);
    const spacing = Math.max(
      1,
      innerWidth - 2 - visibleWidth(cursor) - visibleWidth(left) - visibleWidth(right),
    );
    const content = `${cursor}${left}${" ".repeat(spacing)}${this.theme.fg("dim", right)}`;
    return this.renderRow(selected ? this.theme.bg("selectedBg", content) : content, innerWidth);
  }

  private renderRow(content: string, innerWidth: number): string {
    const pad = Math.max(0, innerWidth - visibleWidth(content));
    return `${this.theme.fg("border", "│")}${content}${" ".repeat(pad)}${this.theme.fg("border", "│")}`;
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

  private getVisibleItems(): Array<{ item: SessionPickerItem; index: number }> {
    if (this.items.length <= MAX_VISIBLE_ROWS) {
      return this.items.map((item, index) => ({ item, index }));
    }

    const sessionIndexes = this.items
      .map((item, index) => (item.kind === "session" ? index : -1))
      .filter((index) => index >= 0);
    const currentSessionListIndex = Math.max(0, sessionIndexes.indexOf(this.selectedIndex));
    const startSessionListIndex = Math.max(
      0,
      Math.min(
        currentSessionListIndex - Math.floor(MAX_VISIBLE_ROWS / 2),
        Math.max(0, sessionIndexes.length - MAX_VISIBLE_ROWS),
      ),
    );
    const endSessionListIndex = Math.min(
      sessionIndexes.length,
      startSessionListIndex + MAX_VISIBLE_ROWS,
    );
    const visibleIndexes = new Set(
      sessionIndexes.slice(startSessionListIndex, endSessionListIndex),
    );
    return this.items
      .map((item, index) => ({ item, index }))
      .filter(({ item, index }) => item.kind !== "session" || visibleIndexes.has(index));
  }
}
