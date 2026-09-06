import {
  copyToClipboard,
  type ExtensionCommandContext,
  type Theme,
  type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import {
  type Focusable,
  matchesKey,
  type TuiMouseEvent,
  type TuiMouseEventResult,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import {
  type LegendHit,
  type LegendItem,
  type LegendLine,
  LegendPointer,
  layoutLegend,
  legendHitAt,
} from "../shared/legend.ts";
import { formatCompactRelativeTime } from "../shared/time.ts";
import type { SubagentState } from "../subagents/classify.ts";
import { type HandoffBoardServices, loadHandoffBoardSnapshot } from "./board-loading.ts";
import {
  buildHandoffBoardView,
  type HandoffBoardSnapshot,
  type HandoffBoardTab,
  type HandoffBoardView,
  type HandoffSubagentsView,
  type UserSessionStatus,
  type UserSessionsView,
} from "./board-view-model.ts";

export {
  collectUserSessions,
  type HandoffBoardServices,
  loadHandoffBoardSnapshot,
} from "./board-loading.ts";

const BOARD_WIDTH = 86;
const ROW_VIEWPORT_SIZE = 8;
const STATUS_DURATION_MS = 3_000;

export type { HandoffBoardSnapshot, UserSessionEntry } from "./board-view-model.ts";

interface BoardMouseTarget {
  run(): void;
  press?: () => void;
}

interface BoardRowHit {
  tab: HandoffBoardTab;
  sessionId: string;
  end: number;
}

interface HandoffBoardActions {
  refresh(): Promise<HandoffBoardSnapshot>;
  stop(sessionId: string): Promise<void>;
  copy(text: string): Promise<void>;
}

export async function openHandoffBoard(
  ctx: ExtensionCommandContext,
  services: HandoffBoardServices,
): Promise<void> {
  const load = async (): Promise<HandoffBoardSnapshot> =>
    loadHandoffBoardSnapshot(ctx.sessionManager.getEntries(), services);
  const initial = await load();

  await ctx.ui.custom<void>(
    (tui, theme, _keybindings, done) =>
      new HandoffBoard(
        theme,
        initial,
        {
          refresh: load,
          async stop(sessionId) {
            if (!services.cancelSubagent) {
              throw new Error("Subagent cancellation is unavailable.");
            }
            await services.cancelSubagent(sessionId);
          },
          copy: copyToClipboard,
        },
        done,
        () => tui.requestRender(),
      ),
    {
      overlay: true,
      overlayOptions: { anchor: "center", width: 86, margin: 1 },
    },
  );
}

export class HandoffBoard implements Focusable {
  focused = false;
  private tab: HandoffBoardTab = "subagents";
  private selectedByTab: Record<HandoffBoardTab, number> = { subagents: 0, "user-sessions": 0 };
  private confirmingStopSessionId: string | undefined;
  private status: string | undefined;
  private statusGeneration = 0;
  private busy = false;
  private rowHits = new Map<number, BoardRowHit>();
  private controlHits = new Map<number, LegendHit[]>();
  private pressedTarget: BoardMouseTarget | undefined;
  private readonly legendPointer = new LegendPointer(() => this.requestRender());

  constructor(
    private readonly theme: Theme,
    private snapshot: HandoffBoardSnapshot,
    private readonly actions: HandoffBoardActions,
    private readonly done: (value: undefined) => void,
    private readonly requestRender: () => void = () => {},
    private readonly now: () => number = Date.now,
    private readonly schedule: (callback: () => void, delayMs: number) => void = scheduleTimeout,
  ) {}

  invalidate(): void {}

  handleInput(data: string): void {
    if (matchesKey(data, "q")) {
      this.clearTransientState();
      this.done(undefined);
      return;
    }
    if (matchesKey(data, "escape")) {
      if (this.confirmingStopSessionId) {
        this.confirmingStopSessionId = undefined;
        this.clearStatus();
        this.requestRender();
        return;
      }
      this.clearStatus();
      this.done(undefined);
      return;
    }
    if (this.busy) {
      return;
    }
    if (this.status) {
      this.clearStatus();
      this.requestRender();
    }
    if (matchesKey(data, "left") || matchesKey(data, "h")) {
      this.setTab("subagents");
    } else if (matchesKey(data, "right") || matchesKey(data, "l")) {
      this.setTab("user-sessions");
    } else if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
      this.setTab(this.tab === "subagents" ? "user-sessions" : "subagents");
    } else if (matchesKey(data, "up") || matchesKey(data, "k")) {
      this.moveSelection(-1);
    } else if (matchesKey(data, "down") || matchesKey(data, "j")) {
      this.moveSelection(1);
    } else if (data === "x") {
      this.handleStop();
    } else if (data === "a") {
      this.handleCopyObserve();
    } else if (data === "c") {
      this.handleCopyResume();
    } else if (data === "r") {
      this.runAction(async () => {
        this.snapshot = await this.actions.refresh();
        this.clampSelection();
        this.setStatus("Refreshed");
      });
    }
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.type === "press") this.pressedTarget = undefined;
    const hit =
      event.type === "press" && !this.busy
        ? legendHitAt(this.controlHits.get(event.y) ?? [], event.x - 2)
        : undefined;
    const legend = this.legendPointer.handleMouse(
      event,
      hit
        ? {
            ...hit,
            run: () => {
              if (!this.busy) hit.run();
            },
          }
        : undefined,
    );
    if (legend) return event.type === "press" ? { ...legend, focus: true } : legend;
    if (event.type === "press") {
      this.pressedTarget =
        event.button === "left" && !this.busy ? this.mouseTargetAt(event) : undefined;
      if (!this.pressedTarget) return undefined;
      this.pressedTarget.press?.();
      return { handled: true, focus: true };
    }
    if (event.type === "click") {
      // Pi keeps press-time coordinates even when selection reflows the board.
      const target = this.pressedTarget;
      this.pressedTarget = undefined;
      if (event.button !== "left" || !target || this.busy) return undefined;
      target.run();
      return { handled: true };
    }
    if (event.type === "wheel" && event.wheelDelta && this.rowHitAt(event)) {
      if (!this.busy) this.moveSelection(Math.sign(event.wheelDelta));
      return { handled: true };
    }
    return undefined;
  }

  private rowHitAt(event: TuiMouseEvent): BoardRowHit | undefined {
    const hit = this.rowHits.get(event.y);
    return hit && event.x >= 2 && event.x < hit.end ? hit : undefined;
  }

  private mouseTargetAt(event: TuiMouseEvent): BoardMouseTarget | undefined {
    const row = this.rowHitAt(event);
    if (row) {
      const select = () => this.selectSession(row.tab, row.sessionId);
      return { press: select, run: select };
    }
    return undefined;
  }

  private sessionIdAt(tab: HandoffBoardTab, index: number): string | undefined {
    return tab === "subagents"
      ? this.snapshot.subagents[index]?.sessionId
      : this.snapshot.userSessions[index]?.sessionId;
  }

  private selectSession(tab: HandoffBoardTab, sessionId: string): void {
    if (this.tab !== tab) return;
    const entries = tab === "subagents" ? this.snapshot.subagents : this.snapshot.userSessions;
    const index = entries.findIndex((entry) => entry.sessionId === sessionId);
    if (index < 0) return;
    this.selectedByTab[tab] = index;
    this.clearTransientState();
    this.requestRender();
  }

  render(width: number): string[] {
    this.rowHits.clear();
    this.controlHits.clear();
    const modalWidth = Math.max(20, Math.min(width, BOARD_WIDTH));
    const innerWidth = modalWidth - 2;
    const bodyWidth = innerWidth - 2;
    const border = (text: string) => this.theme.fg("border", text);
    const row = (content = "") => `${border("│")} ${fitCell(content, bodyWidth)} ${border("│")}`;
    const view = this.currentView();
    const lines = [
      border(`╭${"─".repeat(innerWidth)}╮`),
      row(this.renderHeader(view, bodyWidth)),
      row(),
    ];
    lines.push(row(this.renderTabs(lines.length, bodyWidth)), row());
    const rows =
      view.tab === "subagents"
        ? this.renderSubagentRows(view, bodyWidth, lines.length + 1)
        : this.renderUserSessionRows(view, bodyWidth, lines.length + 1);
    lines.push(...rows.map(row), row(), ...this.renderDetails(view, bodyWidth).map(row), row());
    const footer = this.renderFooter(view, bodyWidth);
    this.controlHits.set(lines.length, footer.hits);
    lines.push(row(footer.text), border(`╰${"─".repeat(innerWidth)}╯`));
    return lines;
  }

  private renderHeader(view: HandoffBoardView, width: number): string {
    const title = this.theme.fg("accent", this.theme.bold("Handoffs"));
    const count = this.theme.fg(
      "muted",
      view.tab === "subagents"
        ? `${view.rows.length} on branch`
        : `${view.rows.length} user sessions`,
    );
    const gap = Math.max(1, width - visibleWidth(title) - visibleWidth(count));
    return fitLine(`${title}${" ".repeat(gap)}${count}`, width);
  }

  private renderTabs(row: number, width: number): string {
    this.controlHits.set(
      row,
      [
        { id: "tab:subagents", start: 0, end: 9, run: () => this.setTab("subagents") },
        { id: "tab:user-sessions", start: 11, end: 24, run: () => this.setTab("user-sessions") },
      ].filter((hit) => hit.end <= width),
    );
    const subagents =
      this.tab === "subagents"
        ? this.theme.fg("accent", this.theme.bold("Subagents"))
        : this.theme.fg("dim", "Subagents");
    const userSessions =
      this.tab === "user-sessions"
        ? this.theme.fg("accent", this.theme.bold("User sessions"))
        : this.theme.fg("dim", "User sessions");
    const shownSubagents =
      width >= 9 && this.legendPointer.pressedId === "tab:subagents"
        ? this.theme.bg("selectedBg", subagents)
        : subagents;
    const shownUserSessions =
      width >= 24 && this.legendPointer.pressedId === "tab:user-sessions"
        ? this.theme.bg("selectedBg", userSessions)
        : userSessions;
    return `${shownSubagents}  ${shownUserSessions}`;
  }

  private renderSubagentRows(
    view: HandoffSubagentsView,
    width: number,
    firstRow: number,
  ): string[] {
    const rows = view.rows;
    const statusWidth = 11;
    const ageWidth = 4;
    const firstWidth = Math.max(8, width - 2 - statusWidth - ageWidth - 4);
    const header = gridRow(
      [
        { text: "Subagent", width: firstWidth, color: "muted" },
        { text: "Status", width: statusWidth, color: "muted" },
        { text: "Age", width: ageWidth, align: "right", color: "muted" },
      ],
      this.theme,
    );
    if (rows.length === 0) {
      return [header, this.theme.fg("dim", "  No subagents on the active branch")];
    }
    const start = viewportStart(rows.length, this.selectedByTab.subagents);
    return [
      header,
      ...rows.slice(start, start + ROW_VIEWPORT_SIZE).map((entry, visibleIndex) => {
        const index = start + visibleIndex;
        const selected = index === this.selectedByTab.subagents;
        this.recordRowHit(firstRow + visibleIndex, view.tab, index, width);
        const indent = "  ".repeat(Math.max(0, entry.depth - 1));
        const dot = this.theme.fg(stateColor(entry.status), stateDot(entry.status));
        const first = `${indent}${dot} ${entry.title}`;
        const line = gridRow(
          [
            { text: first, width: firstWidth },
            { text: entry.status, width: statusWidth, color: stateColor(entry.status) },
            {
              text: formatAge(entry.timestamp, this.now()),
              width: ageWidth,
              align: "right",
              color: "dim",
            },
          ],
          this.theme,
          selected,
        );
        return selected ? this.theme.bg("selectedBg", line) : line;
      }),
    ];
  }

  private renderUserSessionRows(view: UserSessionsView, width: number, firstRow: number): string[] {
    const rows = view.rows;
    const statusWidth = 11;
    const ageWidth = 4;
    const firstWidth = Math.max(8, width - 2 - statusWidth - ageWidth - 4);
    const header = gridRow(
      [
        { text: "Session", width: firstWidth, color: "muted" },
        { text: "Status", width: statusWidth, color: "muted" },
        { text: "Age", width: ageWidth, align: "right", color: "muted" },
      ],
      this.theme,
    );
    if (rows.length === 0) {
      return [header, this.theme.fg("dim", "  No user sessions recorded")];
    }
    const start = viewportStart(rows.length, this.selectedByTab["user-sessions"]);
    return [
      header,
      ...rows.slice(start, start + ROW_VIEWPORT_SIZE).map((entry, visibleIndex) => {
        const index = start + visibleIndex;
        const selected = index === this.selectedByTab["user-sessions"];
        this.recordRowHit(firstRow + visibleIndex, view.tab, index, width);
        const line = gridRow(
          [
            { text: entry.title, width: firstWidth },
            {
              text: entry.status,
              width: statusWidth,
              color: userSessionStatusColor(entry.status),
            },
            {
              text: formatAge(entry.timestamp, this.now()),
              width: ageWidth,
              align: "right",
              color: "dim",
            },
          ],
          this.theme,
          selected,
        );
        return selected ? this.theme.bg("selectedBg", line) : line;
      }),
    ];
  }

  private recordRowHit(row: number, tab: HandoffBoardTab, index: number, width: number): void {
    const sessionId = this.sessionIdAt(tab, index);
    if (sessionId) this.rowHits.set(row, { tab, sessionId, end: width + 2 });
  }

  private renderDetails(view: HandoffBoardView, width: number): string[] {
    const lines = this.detailLines(view);
    const innerWidth = Math.max(1, width - 2);
    const label = " Details ";
    const top = `┌─${label}${"─".repeat(Math.max(0, innerWidth - label.length - 1))}┐`;
    const bottom = `└${"─".repeat(innerWidth)}┘`;
    let color: ThemeColor = "dim";
    if (view.tab === "subagents") {
      const selected = view.rows[this.selectedByTab.subagents];
      if (selected) {
        color = stateColor(selected.status);
      }
    } else {
      const selected = view.rows[this.selectedByTab["user-sessions"]];
      if (selected) {
        color = userSessionStatusColor(selected.status);
      }
    }
    return [
      this.theme.fg(color, fitLine(top, width)),
      ...lines.map((line) => {
        const content = fitCell(line, Math.max(0, innerWidth - 2));
        return `${this.theme.fg(color, "│")} ${content} ${this.theme.fg(color, "│")}`;
      }),
      this.theme.fg(color, fitLine(bottom, width)),
    ];
  }

  private detailLines(view: HandoffBoardView): string[] {
    if (view.details.length === 0) {
      const message =
        view.tab === "subagents"
          ? "No active-branch subagent selected"
          : "No user session selected";
      return [this.theme.fg("dim", message)];
    }
    return view.details.map((detail) => detailLine(this.theme, detail.label, detail.value));
  }

  private renderFooter(view: HandoffBoardView, width: number): LegendLine {
    if (this.busy) {
      return { text: this.theme.fg("dim", "Working…"), hits: [] };
    }
    if (this.confirmingStopSessionId) {
      const sessionId = this.confirmingStopSessionId;
      const prefix = "Stop “";
      const suffix = "”?  x confirm  ·  esc cancel";
      const titleWidth = Math.max(1, width - visibleWidth(prefix) - visibleWidth(suffix));
      const title = truncateToWidth(view.action?.subagent?.title ?? "subagent", titleWidth, "…");
      const question = `${prefix}${title}”?  `;
      const legend = layoutLegend(
        this.theme,
        [
          {
            key: "x",
            description: "confirm",
            run: this.guardAction(view, () => this.handleStop()),
          },
          {
            key: "esc",
            description: "cancel",
            run: () => {
              if (this.confirmingStopSessionId !== sessionId) return;
              this.clearTransientState();
              this.requestRender();
            },
          },
        ],
        {
          width: Math.max(0, width - visibleWidth(question)),
          separator: "  ·  ",
          pressedId: this.legendPointer.pressedId,
        },
      );
      return {
        text: this.theme.fg("warning", `${question}${legend.text}`),
        hits: legend.hits.map((hit) => ({
          ...hit,
          start: hit.start + visibleWidth(question),
          end: hit.end + visibleWidth(question),
        })),
      };
    }
    if (this.status) {
      return { text: this.theme.fg("dim", this.status), hits: [] };
    }

    const action = view.action;
    const items: LegendItem[] = [
      { key: "<>", description: "tab" },
      { key: "↑↓", description: "select" },
    ];
    if (action?.canStop) {
      items.push({
        key: "x",
        description: "stop",
        run: this.guardAction(view, () => this.handleStop()),
      });
    }
    if (action?.observeCommand) {
      items.push({
        key: "a",
        description: "copy observe",
        run: this.guardAction(view, () => this.handleCopyObserve()),
      });
    }
    if (action?.resumeCommand) {
      items.push({
        key: "c",
        description: "copy resume",
        run: this.guardAction(view, () => this.handleCopyResume()),
      });
    }
    items.push({
      key: "esc",
      description: "close",
      run: () => {
        this.clearTransientState();
        this.done(undefined);
      },
    });

    return layoutLegend(this.theme, items, {
      width,
      pressedId: this.legendPointer.pressedId,
      trailing: view.rows.length
        ? `${this.selectedByTab[this.tab] + 1} of ${view.rows.length}`
        : "",
    });
  }

  private guardAction(view: HandoffBoardView, run: () => void): () => void {
    const sessionId = this.sessionIdAt(view.tab, this.selectedByTab[view.tab]);
    const confirming = this.confirmingStopSessionId;
    return () => {
      if (
        this.tab !== view.tab ||
        this.sessionIdAt(this.tab, this.selectedByTab[this.tab]) !== sessionId
      )
        return;
      if (this.confirmingStopSessionId !== confirming) return;
      const action = this.currentView().action;
      if (
        action?.canStop !== view.action?.canStop ||
        action?.observeCommand !== view.action?.observeCommand ||
        action?.resumeCommand !== view.action?.resumeCommand
      )
        return;
      run();
    };
  }

  private setTab(tab: HandoffBoardTab): void {
    this.tab = tab;
    this.clearTransientState();
    this.clampSelection();
    this.requestRender();
  }

  private moveSelection(delta: number): void {
    const count =
      this.tab === "subagents" ? this.snapshot.subagents.length : this.snapshot.userSessions.length;
    if (count === 0) {
      return;
    }
    this.selectedByTab[this.tab] = Math.max(
      0,
      Math.min(count - 1, this.selectedByTab[this.tab] + delta),
    );
    this.clearTransientState();
    this.requestRender();
  }

  private clampSelection(): void {
    for (const tab of ["subagents", "user-sessions"] as const) {
      const count =
        tab === "subagents" ? this.snapshot.subagents.length : this.snapshot.userSessions.length;
      this.selectedByTab[tab] = Math.max(
        0,
        Math.min(Math.max(0, count - 1), this.selectedByTab[tab]),
      );
    }
  }

  private clearTransientState(): void {
    this.confirmingStopSessionId = undefined;
    this.clearStatus();
  }

  private clearStatus(): void {
    this.status = undefined;
    this.statusGeneration += 1;
  }

  private setStatus(status: string, dismiss = true): void {
    this.status = status;
    const generation = ++this.statusGeneration;
    if (!dismiss) {
      return;
    }
    this.schedule(() => {
      if (this.statusGeneration !== generation) {
        return;
      }
      this.status = undefined;
      this.statusGeneration += 1;
      this.requestRender();
    }, STATUS_DURATION_MS);
  }

  private handleStop(): void {
    const action = this.currentView().action;
    if (!action?.canStop || !action.subagent) {
      return;
    }
    if (this.confirmingStopSessionId !== action.subagent.sessionId) {
      this.confirmingStopSessionId = action.subagent.sessionId;
      this.clearStatus();
      this.requestRender();
      return;
    }
    const subagent = action.subagent;
    this.confirmingStopSessionId = undefined;
    this.runAction(async () => {
      await this.actions.stop(subagent.sessionId);
      this.snapshot = await this.actions.refresh();
      this.clampSelection();
      this.setStatus(`Stopped ${subagent.title}`);
    });
  }

  private handleCopyObserve(): void {
    const command = this.currentView().action?.observeCommand;
    if (!command) {
      return;
    }
    this.runAction(async () => {
      await this.actions.copy(command);
      this.setStatus("Observe command copied");
    });
  }

  private handleCopyResume(): void {
    const command = this.currentView().action?.resumeCommand;
    if (!command) {
      return;
    }
    this.runAction(async () => {
      await this.actions.copy(command);
      this.setStatus("Resume command copied");
    });
  }

  private runAction(action: () => Promise<void>): void {
    this.busy = true;
    this.clearStatus();
    this.requestRender();
    void action()
      .catch((error: unknown) => {
        this.setStatus(error instanceof Error ? error.message : String(error), false);
      })
      .finally(() => {
        this.busy = false;
        this.requestRender();
      });
  }

  private currentView(): HandoffBoardView {
    return buildHandoffBoardView(this.snapshot, this.tab, this.selectedByTab[this.tab], {
      insideTmux: Boolean(process.env.TMUX),
    });
  }
}

function viewportStart(rowCount: number, selectedIndex: number): number {
  if (rowCount <= ROW_VIEWPORT_SIZE || selectedIndex < ROW_VIEWPORT_SIZE) {
    return 0;
  }
  return Math.min(selectedIndex - ROW_VIEWPORT_SIZE + 1, rowCount - ROW_VIEWPORT_SIZE);
}

function scheduleTimeout(callback: () => void, delayMs: number): void {
  const timeout = setTimeout(callback, delayMs);
  timeout.unref();
}

interface GridCell {
  text: string;
  width: number;
  align?: "left" | "right" | undefined;
  color?: ThemeColor | undefined;
}

function gridRow(cells: readonly GridCell[], theme: Theme, selected = false): string {
  const rendered = cells.map((cell) => {
    const content = fitCell(cell.text, cell.width, cell.align);
    return cell.color ? theme.fg(cell.color, content) : content;
  });
  const cursor = selected ? `${theme.fg("accent", "›")} ` : "  ";
  return `${cursor}${rendered.join("  ")}`;
}

function detailLine(theme: Theme, label: string, value: string): string {
  return `${theme.fg("muted", label.padEnd(10))}${value}`;
}

function fitCell(value: string, width: number, align: "left" | "right" = "left"): string {
  if (width <= 0) {
    return "";
  }
  const truncated = truncateToWidth(value, width, "…");
  const padding = " ".repeat(Math.max(0, width - visibleWidth(truncated)));
  return align === "right" ? `${padding}${truncated}` : `${truncated}${padding}`;
}

function fitLine(value: string, width: number): string {
  return width <= 0 ? "" : truncateToWidth(value, width, "");
}

function formatAge(timestamp: string, now: number): string {
  return formatCompactRelativeTime(timestamp, now) ?? "—";
}

function stateDot(state: SubagentState): string {
  switch (state) {
    case "starting":
    case "busy":
    case "active":
      return "●";
    case "completed":
    case "stopping":
    case "stopped":
    case "suspended":
    case "interrupted":
    case "unknown":
      return "○";
  }
}

function stateColor(state: SubagentState): "success" | "error" | "warning" | "dim" {
  switch (state) {
    case "busy":
    case "active":
      return "success";
    case "starting":
    case "interrupted":
    case "unknown":
      return "warning";
    case "stopped":
    case "stopping":
      return "error";
    case "completed":
    case "suspended":
      return "dim";
  }
}

function userSessionStatusColor(state: UserSessionStatus): "success" | "warning" | "muted" {
  switch (state) {
    case "live":
      return "success";
    case "starting":
    case "unknown":
      return "warning";
    case "closed":
    case "ready":
      return "muted";
  }
}
