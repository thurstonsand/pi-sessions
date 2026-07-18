import {
  BorderedLoader,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { type Focusable, matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import { type ReindexResult, rebuildSessionIndex } from "../session-search/reindex.ts";
import type { IndexHandle } from "../shared/composition.ts";
import { isTuiMode } from "../shared/pi-mode.ts";
import { getIndexStatus, type SessionIndexStatus } from "../shared/session-index/index.ts";
import type { SessionSettings } from "../shared/settings.ts";

type SessionIndexAction = "reindex" | undefined;

export function installIndex(pi: ExtensionAPI, deps: { settings: SessionSettings }): IndexHandle {
  const indexPath = deps.settings.index.path;

  pi.registerCommand("session-index", {
    description: "Open the session index control panel",
    handler: async (_args, ctx) => {
      if (!isTuiMode(ctx)) {
        ctx.ui.notify("/session-index requires interactive mode.", "warning");
        return;
      }

      const status = getIndexStatus(indexPath);
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

      const result = await runReindexWithLoader(ctx, indexPath);
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

  return { path: indexPath };
}

class SessionIndexPanel implements Focusable {
  readonly width = 72;
  focused = false;

  invalidate(): void {}

  constructor(
    private readonly theme: Theme,
    private readonly status: SessionIndexStatus,
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

async function runReindexWithLoader(
  ctx: ExtensionCommandContext,
  indexPath: string,
): Promise<ReindexResult | null> {
  return ctx.ui.custom<ReindexResult | null>((tui, theme, _keybindings, done) => {
    const loader = new BorderedLoader(tui, theme, "Rebuilding session index...");
    loader.onAbort = () => done(null);

    void (async () => {
      try {
        const result = await rebuildSessionIndex({ indexPath });
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
