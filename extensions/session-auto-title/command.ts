import type { ExtensionCommandContext } from "@mariozechner/pi-coding-agent";
import type { AutocompleteItem } from "@mariozechner/pi-tui";

export const TITLE_USAGE = "Usage: /title [this|folder|pi] [-f]";

export type RetitleScope = "this" | "folder" | "global";
export type RetitleMode = "backfill" | "all";

export type RetitleCommandInvocation =
  | { kind: "open-pane" }
  | {
      kind: "run";
      scope: RetitleScope;
      mode?: RetitleMode;
      force?: boolean;
    };

export type RetitleCommandParseResult =
  | RetitleCommandInvocation
  | {
      kind: "error";
      message: string;
    };

export type RetitleCommandOutcome = "success" | "cancelled" | "failed";

const VALID_TOKENS = new Set(["this", "folder", "pi", "-f"]);

const ARGUMENT_COMPLETIONS: AutocompleteItem[] = [
  {
    value: "this",
    label: "this",
    description: "Retitle the current session immediately",
  },
  {
    value: "folder",
    label: "folder",
    description: "Backfill untitled sessions in this folder; add -f to skip confirmation",
  },
  {
    value: "pi",
    label: "pi",
    description: "Backfill untitled sessions across all of Pi; add -f to skip confirmation",
  },
];

export function createSessionAutoTitleCommandHandler(
  execute: (
    invocation: RetitleCommandInvocation,
    ctx: ExtensionCommandContext,
  ) => Promise<RetitleCommandOutcome>,
): (args: string, ctx: ExtensionCommandContext) => Promise<void> {
  return async (args: string, ctx: ExtensionCommandContext): Promise<void> => {
    const parsed = parseRetitleCommand(args, ctx.hasUI);
    if (parsed.kind === "error") {
      ctx.ui.notify(parsed.message, "error");
      return;
    }

    if (parsed.kind === "run") {
      await ctx.waitForIdle();
    }

    const outcome = await execute(parsed, ctx);
    if (outcome === "failed") {
      ctx.ui.notify("Session retitle failed.", "error");
    }
  };
}

export function getRetitleArgumentCompletions(argumentPrefix: string): AutocompleteItem[] | null {
  const normalizedPrefix = argumentPrefix.trimStart().toLowerCase();
  const filtered = ARGUMENT_COMPLETIONS.filter((item) =>
    item.value.toLowerCase().startsWith(normalizedPrefix),
  );
  return filtered.length > 0 ? filtered : null;
}

export function parseRetitleCommand(args: string, hasUI: boolean): RetitleCommandParseResult {
  const trimmedArgs = args.trim();
  if (!trimmedArgs) {
    return hasUI ? { kind: "open-pane" } : { kind: "run", scope: "this" };
  }

  const tokens = trimmedArgs.split(/\s+/);
  const tokenSet = new Set(tokens);
  if (tokenSet.size !== tokens.length || tokens.some((t) => !VALID_TOKENS.has(t))) {
    return { kind: "error", message: TITLE_USAGE };
  }

  if (tokenSet.has("this")) {
    if (tokenSet.size !== 1) {
      return { kind: "error", message: TITLE_USAGE };
    }
    return { kind: "run", scope: "this" };
  }

  const scopeCount = Number(tokenSet.has("folder")) + Number(tokenSet.has("pi"));
  if (scopeCount !== 1) {
    return { kind: "error", message: TITLE_USAGE };
  }

  return {
    kind: "run",
    scope: tokenSet.has("pi") ? "global" : "folder",
    mode: "backfill",
    ...(tokenSet.has("-f") && { force: true }),
  };
}
