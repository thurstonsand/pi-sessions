import type { Api, Model } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@mariozechner/pi-coding-agent";
import type { Focusable, TUI } from "@mariozechner/pi-tui";
import { matchesKey, visibleWidth } from "@mariozechner/pi-tui";
import type { RetitleCommandOutcome, RetitleMode, RetitleScope } from "./command.js";
import type { AutoRetitleStatus, SessionAutoTitleController } from "./controller.js";
import {
  buildBulkRetitleMessage,
  buildRetitleScopeScan,
  buildScopeScanMessage,
  formatScopeLocation,
  getEligibleSessions,
  notifyBulkRetitleResult,
  type RetitleScopeScan,
  runBulkRetitle,
  runRetitlePlan,
} from "./retitle.js";

interface RetitleWizardOptions {
  initialInvocation?: {
    scope: Exclude<RetitleScope, "this">;
    mode: RetitleMode;
  };
}

type RetitleWizardStep =
  | { kind: "scope" }
  | { kind: "scan"; scope: Exclude<RetitleScope, "this"> }
  | {
      kind: "empty";
      scan: RetitleScopeScan;
      mode?: RetitleMode;
    }
  | {
      kind: "confirm-mode";
      scan: RetitleScopeScan;
    }
  | {
      kind: "warning";
      scan: RetitleScopeScan;
    }
  | {
      kind: "running";
      message: string;
    };

export async function showRetitleWizard(
  pi: ExtensionAPI,
  controller: SessionAutoTitleController,
  ctx: ExtensionCommandContext,
  model: Model<Api> | undefined,
  getSessionEpoch: () => number,
  options?: RetitleWizardOptions,
): Promise<RetitleCommandOutcome> {
  return ctx.ui.custom<RetitleCommandOutcome>(
    (tui, theme, _keybindings, done) =>
      new RetitleWizardPanel(
        tui,
        theme,
        pi,
        controller,
        ctx,
        model,
        getSessionEpoch,
        done,
        options,
      ),
    {
      overlay: true,
      overlayOptions: {
        anchor: "center",
        width: 88,
        margin: 1,
      },
    },
  );
}

class RetitleWizardPanel implements Focusable {
  focused = false;

  private selectedIndex = 0;
  private step: RetitleWizardStep;

  constructor(
    private readonly tui: TUI,
    private readonly theme: Theme,
    private readonly pi: ExtensionAPI,
    private readonly controller: SessionAutoTitleController,
    private readonly ctx: ExtensionCommandContext,
    private readonly model: Model<Api> | undefined,
    private readonly getSessionEpoch: () => number,
    private readonly done: (result: RetitleCommandOutcome) => void,
    options?: RetitleWizardOptions,
  ) {
    this.step = options?.initialInvocation
      ? { kind: "scan", scope: options.initialInvocation.scope }
      : { kind: "scope" };

    if (options?.initialInvocation) {
      void this.scanScope(options.initialInvocation.scope, options.initialInvocation.mode);
    }
  }

  invalidate(): void {}

  handleInput(data: string): void {
    if (matchesKey(data, "escape")) {
      this.done("cancelled");
      return;
    }

    switch (this.step.kind) {
      case "scope":
        this.handleScopeInput(data);
        return;
      case "confirm-mode":
        this.handleConfirmModeInput(data);
        return;
      case "warning":
        if (matchesKey(data, "enter")) {
          void this.runBulkRetitle(this.step.scan, "all");
        }
        return;
      case "empty":
        if (matchesKey(data, "enter")) {
          this.done("success");
        }
        return;
      case "scan":
      case "running":
        return;
    }
  }

  render(width: number): string[] {
    const innerWidth = Math.max(1, width - 2);
    const lines: string[] = [this.theme.fg("border", `╭${"─".repeat(innerWidth)}╮`)];

    switch (this.step.kind) {
      case "scope":
        this.renderScopeStep(lines, innerWidth);
        break;
      case "scan":
        this.renderScanStep(lines, innerWidth, this.step.scope);
        break;
      case "empty":
        this.renderEmptyStep(lines, innerWidth, this.step.scan, this.step.mode);
        break;
      case "confirm-mode":
        this.renderConfirmModeStep(lines, innerWidth, this.step.scan);
        break;
      case "warning":
        this.renderWarningStep(lines, innerWidth, this.step.scan.totalCount);
        break;
      case "running":
        this.renderRunningStep(lines, innerWidth, this.step.message);
        break;
    }

    lines.push(this.theme.fg("border", `╰${"─".repeat(innerWidth)}╯`));
    return lines;
  }

  private handleScopeInput(data: string): void {
    const options: RetitleScope[] = ["this", "folder", "global"];
    if (matchesKey(data, "up") || data === "k") {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      this.requestRender();
      return;
    }

    if (matchesKey(data, "down") || data === "j") {
      this.selectedIndex = Math.min(options.length - 1, this.selectedIndex + 1);
      this.requestRender();
      return;
    }

    if (data === "t" || data === "T") {
      void this.runCurrentSessionRetitle();
      return;
    }

    if (data === "f" || data === "F") {
      void this.scanScope("folder");
      return;
    }

    if (data === "p" || data === "P") {
      void this.scanScope("global");
      return;
    }

    if (matchesKey(data, "enter")) {
      const selected = options[this.selectedIndex];
      if (selected === "this") {
        void this.runCurrentSessionRetitle();
        return;
      }

      if (selected) {
        void this.scanScope(selected);
      }
    }
  }

  private handleConfirmModeInput(data: string): void {
    // RetitleWizardStep uses anonymous inline members; Extract narrows to the correct variant
    const { scan } = this.step as Extract<RetitleWizardStep, { kind: "confirm-mode" }>;

    if (matchesKey(data, "enter")) {
      void this.runBulkRetitle(scan, "backfill");
      return;
    }

    if (data === "a" || data === "A") {
      if (scan.scope === "global") {
        this.step = { kind: "warning", scan };
        this.requestRender();
        return;
      }

      void this.runBulkRetitle(scan, "all");
    }
  }

  private async runCurrentSessionRetitle(): Promise<void> {
    this.step = { kind: "running", message: "Generating title for this session..." };
    this.requestRender();
    await this.ctx.waitForIdle();

    const didRetitle = await runRetitlePlan({
      pi: this.pi,
      controller: this.controller,
      ctx: this.ctx,
      model: this.model,
      isManual: true,
      getSessionEpoch: this.getSessionEpoch,
    });
    this.done(didRetitle ? "success" : "failed");
  }

  private async scanScope(
    scope: Exclude<RetitleScope, "this">,
    fixedMode?: RetitleMode,
  ): Promise<void> {
    this.step = { kind: "scan", scope };
    this.requestRender();

    try {
      const scan = await buildRetitleScopeScan(this.ctx, scope);
      if (scan.totalCount === 0) {
        this.step = { kind: "empty", scan };
        this.requestRender();
        return;
      }

      if (fixedMode && getEligibleSessions(scan.sessions, fixedMode).length === 0) {
        this.step = { kind: "empty", scan, mode: fixedMode };
        this.requestRender();
        return;
      }

      this.step = { kind: "confirm-mode", scan };
      this.requestRender();
    } catch {
      this.done("failed");
    }
  }

  private async runBulkRetitle(scan: RetitleScopeScan, mode: RetitleMode): Promise<void> {
    if (mode === "backfill" && getEligibleSessions(scan.sessions, "backfill").length === 0) {
      this.step = { kind: "empty", scan, mode: "backfill" };
      this.requestRender();
      return;
    }

    this.step = { kind: "running", message: buildBulkRetitleMessage(scan.scope, mode) };
    this.requestRender();
    await this.ctx.waitForIdle();

    const result = await runBulkRetitle(
      this.pi,
      this.controller,
      this.ctx,
      this.model,
      scan,
      mode,
      this.getSessionEpoch,
    );
    notifyBulkRetitleResult(this.ctx, scan, mode, result);
    this.done(
      result.failed > 0 && result.retitled === 0 && result.unchanged === 0 ? "failed" : "success",
    );
  }

  private renderScopeStep(lines: string[], innerWidth: number): void {
    const autoRetitleStatus = this.controller.getAutoRetitleStatus(this.ctx);
    const options: Array<{ key: string; suffix: string; selected: boolean }> = [
      {
        key: "t",
        suffix:
          autoRetitleStatus.mode === "paused_manual"
            ? " Regenerate title for this session (restarts auto-updates)"
            : " Regenerate title for this session",
        selected: this.selectedIndex === 0,
      },
      {
        key: "f",
        suffix: " Generate titles for all sessions in this folder",
        selected: this.selectedIndex === 1,
      },
      {
        key: "p",
        suffix: " Generate titles for all sessions of Pi",
        selected: this.selectedIndex === 2,
      },
    ];

    lines.push(
      this.renderRow(innerWidth, ` ${this.theme.bold(this.theme.fg("accent", "Session Titles"))}`),
    );
    lines.push(this.renderRow(innerWidth, ""));
    for (const titleLine of formatCurrentSessionTitleLines(
      this.theme,
      this.ctx.sessionManager.getSessionName(),
      innerWidth,
    )) {
      lines.push(this.renderRow(innerWidth, titleLine));
    }
    lines.push(
      this.renderRow(innerWidth, formatAutoRetitleStatusLine(this.theme, autoRetitleStatus)),
    );
    lines.push(this.renderRow(innerWidth, ""));

    for (const option of options) {
      const prefix = option.selected ? this.theme.fg("accent", "›") : " ";
      const text = `${this.theme.bold(option.key)}${option.suffix}`;
      const label = option.selected ? this.theme.fg("accent", text) : text;
      lines.push(this.renderRow(innerWidth, ` ${prefix} ${label}`));
    }
  }

  private renderScanStep(
    lines: string[],
    innerWidth: number,
    scope: Exclude<RetitleScope, "this">,
  ): void {
    lines.push(
      this.renderRow(innerWidth, ` ${this.theme.bold(this.theme.fg("accent", "Session Titles"))}`),
    );
    lines.push(this.renderRow(innerWidth, ""));
    lines.push(this.renderRow(innerWidth, ` ${buildScopeScanMessage(scope)}`));
  }

  private renderEmptyStep(
    lines: string[],
    innerWidth: number,
    scan: RetitleScopeScan,
    mode?: RetitleMode,
  ): void {
    const location = formatScopeLocation(scan.scope);
    let message: string;
    if (scan.totalCount === 0) {
      message = `No sessions found ${location}.`;
    } else if (mode === "backfill") {
      message = `No untitled sessions found ${location}.`;
    } else {
      message = `No sessions matched ${location}.`;
    }

    lines.push(
      this.renderRow(innerWidth, ` ${this.theme.bold(this.theme.fg("accent", "Session Titles"))}`),
    );
    lines.push(this.renderRow(innerWidth, ""));
    lines.push(this.renderRow(innerWidth, ` ${message}`));
    lines.push(this.renderRow(innerWidth, ""));
    lines.push(this.renderRow(innerWidth, ` ${this.theme.fg("dim", "Enter")} close`));
    lines.push(this.renderRow(innerWidth, ` ${this.theme.fg("dim", "Esc")} cancel`));
  }

  private renderConfirmModeStep(lines: string[], innerWidth: number, scan: RetitleScopeScan): void {
    const title = scan.scope === "folder" ? "In This Folder" : "All of Pi";
    lines.push(this.renderRow(innerWidth, ` ${this.theme.bold(this.theme.fg("accent", title))}`));
    lines.push(this.renderRow(innerWidth, ""));
    lines.push(
      this.renderRow(
        innerWidth,
        ` ${this.theme.bold("Enter")} Generate missing titles (${scan.untitledCount})`,
      ),
    );
    lines.push(
      this.renderRow(
        innerWidth,
        ` ${this.theme.bold("a")} Regenerate all sessions, even ones that already have titles (${scan.totalCount})`,
      ),
    );
    lines.push(this.renderRow(innerWidth, ` ${this.theme.fg("dim", "Esc")} cancel`));
  }

  private renderWarningStep(lines: string[], innerWidth: number, sessionCount: number): void {
    lines.push(
      this.renderRow(innerWidth, ` ${this.theme.bold(this.theme.fg("error", "WARNING"))}`),
    );
    lines.push(this.renderRow(innerWidth, ""));
    lines.push(
      this.renderRow(innerWidth, ` This will retitle ${sessionCount} sessions across all of Pi.`),
    );
    lines.push(this.renderRow(innerWidth, " This may take some time and may be expensive."));
    lines.push(this.renderRow(innerWidth, ""));
    lines.push(this.renderRow(innerWidth, ` ${this.theme.fg("accent", "Enter")} continue`));
    lines.push(this.renderRow(innerWidth, ` ${this.theme.fg("dim", "Esc")} cancel`));
  }

  private renderRunningStep(lines: string[], innerWidth: number, message: string): void {
    lines.push(
      this.renderRow(innerWidth, ` ${this.theme.bold(this.theme.fg("accent", "Session Titles"))}`),
    );
    lines.push(this.renderRow(innerWidth, ""));
    lines.push(this.renderRow(innerWidth, ` ${message}`));
  }

  private renderRow(innerWidth: number, content: string): string {
    const pad = Math.max(0, innerWidth - visibleWidth(content));
    return `${this.theme.fg("border", "│")}${content}${" ".repeat(pad)}${this.theme.fg("border", "│")}`;
  }

  private requestRender(): void {
    this.tui.requestRender();
  }
}

function formatCurrentSessionTitleLines(
  theme: Theme,
  title: string | undefined,
  innerWidth: number,
): string[] {
  const prefix = "This session: ";
  const value = title?.trim() || "(untitled)";
  const availableTitleWidth = Math.max(1, innerWidth - visibleWidth(` ${prefix}`));
  const titleLines = wrapText(value, availableTitleWidth);

  return titleLines.map((line, index) => {
    if (index === 0) {
      return ` ${theme.fg("dim", prefix)}${line}`;
    }

    return ` ${" ".repeat(visibleWidth(prefix))}${line}`;
  });
}

function formatAutoRetitleStatusLine(theme: Theme, status: AutoRetitleStatus): string {
  if (status.mode === "paused_manual") {
    return ` ${theme.fg("dim", "(Auto-update disabled)")}`;
  }

  if (status.turnsUntilAutoRetitle === 0) {
    return ` ${theme.fg("dim", "(Auto-update due now)")}`;
  }

  const turnLabel = status.turnsUntilAutoRetitle === 1 ? "turn" : "turns";
  return ` ${theme.fg("dim", `(Auto-update in ${status.turnsUntilAutoRetitle} ${turnLabel})`)}`;
}

function wrapText(text: string, width: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return [""];
  }

  const lines: string[] = [];
  let currentLine = "";

  for (const word of words) {
    if (!currentLine) {
      currentLine = word;
      continue;
    }

    const nextLine = `${currentLine} ${word}`;
    if (visibleWidth(nextLine) <= width) {
      currentLine = nextLine;
      continue;
    }

    lines.push(...splitLongWord(currentLine, width));
    currentLine = word;
  }

  if (currentLine) {
    lines.push(...splitLongWord(currentLine, width));
  }

  return lines;
}

function splitLongWord(word: string, width: number): string[] {
  if (visibleWidth(word) <= width) {
    return [word];
  }

  const parts: string[] = [];
  let remaining = word;
  while (visibleWidth(remaining) > width) {
    parts.push(remaining.slice(0, width));
    remaining = remaining.slice(width);
  }

  if (remaining) {
    parts.push(remaining);
  }

  return parts;
}
