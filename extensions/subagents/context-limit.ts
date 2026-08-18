import type { ContextUsage, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { shouldCompact } from "@earendil-works/pi-coding-agent";
import type { CompactionThresholdSettings } from "../shared/settings.ts";

export interface SubagentContextLimit {
  /** Compact when a delegated turn left the subagent above its own context ceiling. */
  compactIfOverLimit(ctx: ExtensionContext): Promise<void>;
}

/**
 * A subagent inherits its model's context window, which can be far larger than the
 * window a delegated task should run in. Treating `contextLimit` as the subagent's
 * effective window keeps pi's own threshold arithmetic — reserve tokens and all —
 * and only lowers the ceiling it applies to.
 */
export function exceedsSubagentContextLimit(
  usage: ContextUsage | undefined,
  contextLimit: number,
  compaction: CompactionThresholdSettings,
): boolean {
  if (usage?.tokens == null) {
    return false;
  }
  return shouldCompact(usage.tokens, Math.min(usage.contextWindow, contextLimit), compaction);
}

export function createSubagentContextLimit(
  contextLimit: number | undefined,
  readCompactionSettings: () => CompactionThresholdSettings,
): SubagentContextLimit {
  if (contextLimit === undefined) {
    return { compactIfOverLimit: async () => {} };
  }

  return {
    async compactIfOverLimit(ctx) {
      if (
        exceedsSubagentContextLimit(ctx.getContextUsage(), contextLimit, readCompactionSettings())
      ) {
        await new Promise<void>((resolve) => {
          ctx.compact({
            onComplete: () => resolve(),
            onError: (error) => {
              if (ctx.hasUI) {
                ctx.ui.notify(`Subagent context compaction failed: ${error.message}`, "warning");
              }
              resolve();
            },
          });
        });
      }
    },
  };
}
