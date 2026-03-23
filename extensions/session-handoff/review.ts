import type {
  ExtensionCommandContext,
  ExtensionUIContext,
  Theme,
} from "@mariozechner/pi-coding-agent";
import type { Component } from "@mariozechner/pi-tui";
import {
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@mariozechner/pi-tui";

const PREVIEW_TIMEOUT_MS = 8_000;
const PREVIEW_BODY_LINE_LIMIT = 16;

type ReviewAction = "accept" | "edit" | "cancel";

interface TimerHandle {
  stop(): void;
}

interface PreviewClock {
  now(): number;
  setInterval(callback: () => void, delayMs: number): TimerHandle;
}

const defaultPreviewClock: PreviewClock = {
  now() {
    return Date.now();
  },
  setInterval(callback, delayMs) {
    const timer = globalThis.setInterval(callback, delayMs);
    return {
      stop() {
        globalThis.clearInterval(timer);
      },
    };
  },
};

export interface HandoffPreviewOptions {
  timeoutMs?: number;
  clock?: PreviewClock;
}

export class HandoffPreviewComponent implements Component {
  private readonly draft: string;
  private readonly theme: Theme;
  private readonly onDone: (action: ReviewAction) => void;
  private readonly requestRender: () => void;
  private readonly deadlineAt: number;
  private readonly clock: PreviewClock;
  private readonly intervalHandle: TimerHandle;
  private isDone = false;
  private isTimerActive = true;
  private scrollOffset = 0;
  private previewWidth = 80;

  public constructor(
    draft: string,
    theme: Theme,
    requestRender: () => void,
    onDone: (action: ReviewAction) => void,
    options: HandoffPreviewOptions = {},
  ) {
    this.draft = draft;
    this.theme = theme;
    this.requestRender = requestRender;
    this.onDone = onDone;
    this.clock = options.clock ?? defaultPreviewClock;
    this.deadlineAt = this.clock.now() + (options.timeoutMs ?? PREVIEW_TIMEOUT_MS);
    this.intervalHandle = this.clock.setInterval(() => {
      if (this.isDone) {
        return;
      }

      if (!this.isTimerActive) {
        return;
      }

      if (this.clock.now() >= this.deadlineAt) {
        this.finish("accept");
        return;
      }

      this.requestRender();
    }, 200);
  }

  public handleInput(data: string): void {
    if (matchesKey(data, Key.enter)) {
      this.finish("accept");
      return;
    }

    if (matchesKey(data, Key.escape)) {
      this.finish("cancel");
      return;
    }

    if (matchesKey(data, "e")) {
      this.finish("edit");
      return;
    }

    if (matchesKey(data, "j")) {
      this.disableTimer();
      this.scrollBy(1);
      return;
    }

    if (matchesKey(data, "k")) {
      this.disableTimer();
      this.scrollBy(-1);
    }
  }

  public render(width: number): string[] {
    const modalWidth = Math.max(24, width - 4);
    const promptBoxWidth = Math.max(20, modalWidth - 4);
    this.previewWidth = Math.max(16, promptBoxWidth - 4);

    const promptLines = renderPromptSection(
      this.buildPreviewLines(this.previewWidth),
      promptBoxWidth,
      this.theme,
    );

    const contentLines = [
      this.getTitleLine(),
      "",
      this.theme.fg("muted", formatKeymapLine("Enter: start session", "Esc: cancel")),
      this.theme.fg("muted", formatKeymapLine("e: edit prompt", "j/k: scroll")),
      "",
      ...promptLines,
    ];

    return renderStrongModal(contentLines, width, this.theme);
  }

  public invalidate(): void {}

  public stop(): void {
    this.intervalHandle.stop();
  }

  private buildPreviewLines(width: number): string[] {
    const wrappedLines = wrapTextWithAnsi(this.draft, Math.max(20, width));
    const maxOffset = Math.max(0, wrappedLines.length - PREVIEW_BODY_LINE_LIMIT);
    this.scrollOffset = Math.min(this.scrollOffset, maxOffset);

    return wrappedLines
      .slice(this.scrollOffset, this.scrollOffset + PREVIEW_BODY_LINE_LIMIT)
      .map((line) => truncateToWidth(line, width));
  }

  private finish(action: ReviewAction): void {
    if (this.isDone) {
      return;
    }

    this.isDone = true;
    this.intervalHandle.stop();
    this.onDone(action);
  }

  private scrollBy(delta: number): void {
    const wrappedLines = wrapTextWithAnsi(this.draft, Math.max(20, this.previewWidth));
    const maxOffset = Math.max(0, wrappedLines.length - PREVIEW_BODY_LINE_LIMIT);
    const nextOffset = Math.max(0, Math.min(maxOffset, this.scrollOffset + delta));
    if (nextOffset !== this.scrollOffset) {
      this.scrollOffset = nextOffset;
      this.requestRender();
    }
  }

  private disableTimer(): void {
    if (!this.isTimerActive) {
      return;
    }

    this.isTimerActive = false;
    this.requestRender();
  }

  private getTitleLine(): string {
    const title = this.theme.fg("accent", this.theme.bold("Handoff preview"));
    if (!this.isTimerActive) {
      return title;
    }

    return `${title}${this.theme.fg("dim", ` (autostart in ${this.getRemainingSeconds()}s)`)}`;
  }

  private getRemainingSeconds(): number {
    const remainingMs = Math.max(0, this.deadlineAt - this.clock.now());
    return Math.ceil(remainingMs / 1_000);
  }
}

export function renderStrongModal(lines: string[], width: number, theme: Theme): string[] {
  const innerWidth = Math.max(20, width - 4);
  const fillLine = (text: string) => {
    const truncated = truncateToWidth(text, innerWidth, "…", true);
    const padding = Math.max(0, innerWidth - visibleWidth(truncated));
    return theme.bg("customMessageBg", `  ${truncated}${" ".repeat(padding)}  `);
  };

  return ["", ...lines, ""].map(fillLine);
}

function formatKeymapLine(left: string, right: string): string {
  return `${left.padEnd(27, " ")}${right}`;
}

function renderPromptSection(lines: string[], width: number, _theme: Theme): string[] {
  const innerWidth = Math.max(16, width - 4);
  const line = (left: string, text: string, right: string) => {
    const truncated = truncateToWidth(text, innerWidth, "…", true);
    const padding = Math.max(0, innerWidth - visibleWidth(truncated));
    return `${left} ${truncated}${" ".repeat(padding)} ${right}`;
  };

  return [
    `┌${"─".repeat(innerWidth + 2)}┐`,
    ...lines.map((text) => line("│", text, "│")),
    `└${"─".repeat(innerWidth + 2)}┘`,
  ];
}

export async function reviewHandoffDraft(
  ctx: Pick<ExtensionCommandContext, "ui">,
  draft: string,
): Promise<string | undefined> {
  const action = await runPreviewGate(ctx.ui, draft);
  if (action === "cancel") {
    return undefined;
  }

  if (action === "accept") {
    return draft;
  }

  const editedDraft = await ctx.ui.editor("Edit handoff prompt", draft);
  if (!editedDraft?.trim()) {
    return undefined;
  }

  return editedDraft;
}

async function runPreviewGate(
  ui: Pick<ExtensionUIContext, "custom">,
  draft: string,
): Promise<ReviewAction> {
  return ui.custom<ReviewAction>(
    (tui, theme, _keybindings, done) =>
      new HandoffPreviewComponent(draft, theme, () => tui.requestRender(), done),
    {
      overlay: true,
      overlayOptions: {
        anchor: "center",
        width: "80%",
        maxHeight: "80%",
        margin: 2,
      },
    },
  );
}
