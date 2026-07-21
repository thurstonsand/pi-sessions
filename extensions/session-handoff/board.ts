import {
  copyToClipboard,
  type ExtensionCommandContext,
  type SessionEntry,
  type Theme,
  type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { type Focusable, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatCompactRelativeTime } from "../shared/time.ts";
import type { SubagentState } from "../subagents/classify.ts";
import type { SubagentRoster } from "../subagents/roster.ts";
import {
  buildHandoffBoardView,
  type HandoffBoardSnapshot,
  type HandoffBoardTab,
  type HandoffBoardView,
  type HandoffSubagentsView,
  type UserSessionEntry,
  type UserSessionStatus,
  type UserSessionsView,
} from "./board-view-model.ts";
import { HANDOFF_BOOTSTRAP_PENDING_CUSTOM_TYPE } from "./metadata.ts";
import { parseHandoffLaunchReceiptEntry } from "./receipt.ts";

const BOARD_WIDTH = 86;
const ROW_VIEWPORT_SIZE = 8;
const STATUS_DURATION_MS = 3_000;

export type { HandoffBoardSnapshot, UserSessionEntry } from "./board-view-model.ts";

export interface HandoffBoardServices {
  roster?: SubagentRoster | undefined;
  cancelSubagent?: ((sessionId: string) => Promise<unknown>) | undefined;
  listLiveSessions?: (() => Promise<string[]>) | undefined;
  readSessionEntries?: ((sessionFile: string) => readonly SessionEntry[]) | undefined;
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

export async function loadHandoffBoardSnapshot(
  entries: readonly SessionEntry[],
  services: HandoffBoardServices,
): Promise<HandoffBoardSnapshot> {
  const userSessions = collectUserSessions(entries);
  const [branchRoster, liveSessionIds, hydratedUserSessions] = await Promise.all([
    services.roster?.resolve("branch") ?? Promise.resolve({ entries: [], total: 0 }),
    services.listLiveSessions?.() ?? Promise.resolve([]),
    Promise.all(
      userSessions.map(
        async (entry): Promise<UserSessionEntry> => ({
          ...entry,
          runEvidence: loadUserSessionRunEvidence(entry, services),
        }),
      ),
    ),
  ]);
  return {
    subagents: branchRoster.entries,
    userSessions: hydratedUserSessions,
    liveSessionIds: new Set(liveSessionIds),
    hasLiveSessionEvidence: services.listLiveSessions !== undefined,
  };
}

export function collectUserSessions(entries: readonly SessionEntry[]): UserSessionEntry[] {
  const bySessionId = new Map<string, UserSessionEntry>();
  for (const entry of entries) {
    const receipt = parseHandoffLaunchReceiptEntry(entry);
    if (!receipt || receipt.launch === "subagent") {
      continue;
    }
    const candidate = {
      sessionId: receipt.sessionId,
      timestamp: entry.timestamp,
      receipt,
    };
    const existing = bySessionId.get(candidate.sessionId);
    if (!existing || candidate.timestamp > existing.timestamp) {
      bySessionId.set(candidate.sessionId, candidate);
    }
  }
  return [...bySessionId.values()].sort((left, right) =>
    right.timestamp.localeCompare(left.timestamp),
  );
}

function loadUserSessionRunEvidence(
  entry: UserSessionEntry,
  services: HandoffBoardServices,
): NonNullable<UserSessionEntry["runEvidence"]> {
  if (!services.readSessionEntries) {
    return unavailableRunEvidence();
  }

  try {
    return {
      transcriptAvailable: true,
      hasStarted: services
        .readSessionEntries(entry.receipt.childSessionFile)
        .some(isSessionStartupEvidence),
    };
  } catch {
    return unavailableRunEvidence();
  }
}

function unavailableRunEvidence(): NonNullable<UserSessionEntry["runEvidence"]> {
  return { transcriptAvailable: false, hasStarted: false };
}

function isSessionStartupEvidence(entry: SessionEntry): boolean {
  if (entry.type === "session_info") {
    return false;
  }
  if (entry.type !== "custom") {
    return true;
  }
  return entry.customType !== HANDOFF_BOOTSTRAP_PENDING_CUSTOM_TYPE;
}

export class HandoffBoard implements Focusable {
  focused = false;
  private tab: HandoffBoardTab = "subagents";
  private selectedByTab: Record<HandoffBoardTab, number> = { subagents: 0, "user-sessions": 0 };
  private confirmingStopSessionId: string | undefined;
  private status: string | undefined;
  private statusGeneration = 0;
  private busy = false;

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

  render(width: number): string[] {
    const modalWidth = Math.max(20, Math.min(width, BOARD_WIDTH));
    const innerWidth = modalWidth - 2;
    const bodyWidth = innerWidth - 2;
    const border = (text: string) => this.theme.fg("border", text);
    const row = (content = "") => `${border("│")} ${fitCell(content, bodyWidth)} ${border("│")}`;
    const view = this.currentView();
    const rows =
      view.tab === "subagents"
        ? this.renderSubagentRows(view, bodyWidth)
        : this.renderUserSessionRows(view, bodyWidth);

    return [
      border(`╭${"─".repeat(innerWidth)}╮`),
      row(this.renderHeader(view, bodyWidth)),
      row(),
      row(this.renderTabs()),
      row(),
      ...rows.map(row),
      row(),
      ...this.renderDetails(view, bodyWidth).map(row),
      row(),
      row(this.renderFooter(view, bodyWidth)),
      border(`╰${"─".repeat(innerWidth)}╯`),
    ];
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

  private renderTabs(): string {
    const subagents =
      this.tab === "subagents"
        ? this.theme.fg("accent", this.theme.bold("Subagents"))
        : this.theme.fg("dim", "Subagents");
    const userSessions =
      this.tab === "user-sessions"
        ? this.theme.fg("accent", this.theme.bold("User sessions"))
        : this.theme.fg("dim", "User sessions");
    return `${subagents}  ${userSessions}`;
  }

  private renderSubagentRows(view: HandoffSubagentsView, width: number): string[] {
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

  private renderUserSessionRows(view: UserSessionsView, width: number): string[] {
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

  private renderFooter(view: HandoffBoardView, width: number): string {
    if (this.busy) {
      return this.theme.fg("dim", "Working…");
    }
    if (this.confirmingStopSessionId) {
      const prefix = "Stop “";
      const suffix = "”?  x confirm  ·  esc cancel";
      const titleWidth = Math.max(1, width - visibleWidth(prefix) - visibleWidth(suffix));
      const title = truncateToWidth(view.action?.subagent?.title ?? "subagent", titleWidth, "…");
      return this.theme.fg("warning", `${prefix}${title}${suffix}`);
    }
    if (this.status) {
      return this.theme.fg("dim", this.status);
    }

    const action = view.action;
    const parts = [this.hint("<>", "tab"), this.hint("↑↓", "select")];
    if (action?.canStop) {
      parts.push(this.hint("x", "stop"));
    }
    if (action?.observeCommand) {
      parts.push(this.hint("a", "copy observe"));
    }
    if (action?.resumeCommand) {
      parts.push(this.hint("c", "copy resume"));
    }
    parts.push(this.hint("esc", "close"));

    const left = parts.join("  ");
    const position = view.rows.length
      ? this.theme.fg("dim", `${this.selectedByTab[this.tab] + 1} of ${view.rows.length}`)
      : "";
    const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(position));
    return fitLine(`${left}${" ".repeat(gap)}${position}`, width);
  }

  private hint(key: string, description: string): string {
    return this.theme.fg("dim", key) + this.theme.fg("muted", ` ${description}`);
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
