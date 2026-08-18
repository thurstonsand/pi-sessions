import type { ContextUsage, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { CompactionThresholdSettings } from "../extensions/shared/settings.ts";
import {
  createSubagentContextLimit,
  exceedsSubagentContextLimit,
} from "../extensions/subagents/context-limit.ts";

const compaction: CompactionThresholdSettings = {
  enabled: true,
  reserveTokens: 16_384,
  keepRecentTokens: 20_000,
};

const usage = (tokens: number | null, contextWindow = 1_000_000): ContextUsage => ({
  tokens,
  contextWindow,
  percent: tokens === null ? null : (tokens / contextWindow) * 100,
});

describe("subagent context limit", () => {
  it("compacts once the limit minus reserve is passed, well below the model window", () => {
    expect(exceedsSubagentContextLimit(usage(383_000), 400_000, compaction)).toBe(false);
    expect(exceedsSubagentContextLimit(usage(390_000), 400_000, compaction)).toBe(true);
  });

  it("never raises the ceiling above the model's own window", () => {
    expect(exceedsSubagentContextLimit(usage(190_000, 200_000), 400_000, compaction)).toBe(true);
  });

  it("stands down when usage is unknown or compaction is disabled", () => {
    expect(exceedsSubagentContextLimit(usage(null), 400_000, compaction)).toBe(false);
    expect(exceedsSubagentContextLimit(undefined, 400_000, compaction)).toBe(false);
    expect(
      exceedsSubagentContextLimit(usage(900_000), 400_000, { ...compaction, enabled: false }),
    ).toBe(false);
  });

  it("awaits pi's compaction when over the limit", async () => {
    const compact = vi.fn((options: { onComplete?: () => void }) => {
      setTimeout(() => options.onComplete?.(), 0);
    });
    const ctx = {
      getContextUsage: () => usage(500_000),
      compact,
      hasUI: false,
    } as unknown as ExtensionContext;

    await createSubagentContextLimit(400_000, () => compaction).compactIfOverLimit(ctx);

    expect(compact).toHaveBeenCalledTimes(1);
  });

  it("stays inert without a configured limit", async () => {
    const compact = vi.fn();
    const ctx = {
      getContextUsage: () => usage(900_000),
      compact,
      hasUI: false,
    } as unknown as ExtensionContext;

    await createSubagentContextLimit(undefined, () => compaction).compactIfOverLimit(ctx);

    expect(compact).not.toHaveBeenCalled();
  });

  it("surfaces a compaction failure without stalling the settle path", async () => {
    const notify = vi.fn();
    const ctx = {
      getContextUsage: () => usage(500_000),
      compact: (options: { onError?: (error: Error) => void }) => {
        options.onError?.(new Error("Nothing to compact (session too small)"));
      },
      hasUI: true,
      ui: { notify },
    } as unknown as ExtensionContext;

    await createSubagentContextLimit(400_000, () => compaction).compactIfOverLimit(ctx);

    expect(notify).toHaveBeenCalledWith(
      "Subagent context compaction failed: Nothing to compact (session too small)",
      "warning",
    );
  });
});
