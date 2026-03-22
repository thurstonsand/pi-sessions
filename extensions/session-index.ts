import {
  BorderedLoader,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type Theme,
} from "@mariozechner/pi-coding-agent";
import { type Focusable, matchesKey, visibleWidth } from "@mariozechner/pi-tui";
import { getIndexStatus } from "./session-search/db.js";
import { type ReindexResult, rebuildSessionIndex } from "./session-search/reindex.js";

type SessionIndexAction = "reindex" | undefined;

export default function sessionIndexExtension(pi: ExtensionAPI): void {
  pi.registerCommand("session-index", {
    description: "Open the session index control panel",
    handler: async (_args, ctx) => {
      if (!ctx.hasUI) {
        ctx.ui.notify("/session-index requires interactive mode.", "warning");
        return;
      }

      const status = getIndexStatus();
      const action = await ctx.ui.custom<SessionIndexAction>(
        (_tui, theme, _keybindings, done) => new SessionIndexPanel(theme, status, done),
        {
          overlay: true,
          overlayOptions: {
            anchor: "center",
            width: 72,
            margin: 1,
          },
        },
      );

      if (action !== "reindex") {
        return;
      }

      const confirmed = await ctx.ui.confirm(
        "Rebuild session index?",
        "This rebuilds the entire session index from disk. Continue?",
      );
      if (!confirmed) {
        ctx.ui.notify("Reindex cancelled.", "info");
        return;
      }

      const result = await runReindexWithLoader(ctx);
      if (!result) {
        ctx.ui.notify("Reindex cancelled.", "info");
        return;
      }

      ctx.ui.notify(
        `Indexed ${result.sessionCount} sessions and ${result.chunkCount} text chunks.`,
        "info",
      );
    },
  });
}

class SessionIndexPanel implements Focusable {
  readonly width = 72;
  focused = false;

  invalidate(): void {}

  constructor(
    private readonly theme: Theme,
    private readonly status: ReturnType<typeof getIndexStatus>,
    private readonly done: (result: SessionIndexAction) => void,
  ) {}

  handleInput(data: string): void {
    if (isCloseKey(data)) {
      this.done(undefined);
      return;
    }

    if (isReindexKey(data)) {
      this.done("reindex");
    }
  }

  render(_width: number): string[] {
    const innerWidth = this.width - 2;
    const lines: string[] = [this.theme.fg("border", `╭${"─".repeat(innerWidth)}╮`)];

    lines.push(
      this.renderRow(innerWidth, ` ${this.theme.bold(this.theme.fg("accent", "Session Index"))}`),
    );
    lines.push(this.renderRow(innerWidth, ""));
    lines.push(
      this.renderRow(
        innerWidth,
        ` Path: ${this.status.exists ? this.status.dbPath : "<no index found>"}`,
      ),
    );
    lines.push(
      this.renderRow(
        innerWidth,
        ` Schema version: ${this.status.schemaVersion !== undefined ? String(this.status.schemaVersion) : "n/a"}`,
      ),
    );
    lines.push(
      this.renderRow(
        innerWidth,
        ` Session count: ${this.status.sessionCount !== undefined ? String(this.status.sessionCount) : "n/a"}`,
      ),
    );
    lines.push(
      this.renderRow(innerWidth, ` Last full reindex: ${this.status.lastFullReindexAt ?? "n/a"}`),
    );
    lines.push(this.renderRow(innerWidth, ""));
    lines.push(this.renderRow(innerWidth, ` ${this.theme.fg("accent", "R")} rebuild from disk`));
    lines.push(this.renderRow(innerWidth, ` ${this.theme.fg("dim", "Enter / Esc")} close`));
    lines.push(this.theme.fg("border", `╰${"─".repeat(innerWidth)}╯`));
    return lines;
  }

  private renderRow(innerWidth: number, content: string): string {
    const pad = Math.max(0, innerWidth - visibleWidth(content));
    return `${this.theme.fg("border", "│")}${content}${" ".repeat(pad)}${this.theme.fg("border", "│")}`;
  }
}

async function runReindexWithLoader(ctx: ExtensionCommandContext): Promise<ReindexResult | null> {
  return ctx.ui.custom<ReindexResult | null>((tui, theme, _keybindings, done) => {
    const loader = new BorderedLoader(tui, theme, "Rebuilding session index...");
    loader.onAbort = () => done(null);

    void (async () => {
      try {
        const result = await rebuildSessionIndex();
        done(result);
      } catch (error) {
        ctx.ui.notify(`Reindex failed: ${String(error)}`, "error");
        done(null);
      }
    })();

    return loader;
  });
}

function isCloseKey(data: string): boolean {
  return matchesKey(data, "escape") || matchesKey(data, "enter");
}

function isReindexKey(data: string): boolean {
  return data === "r" || data === "R" || matchesKey(data, "r");
}
