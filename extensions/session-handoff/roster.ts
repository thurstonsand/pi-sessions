import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ScopedModel } from "@earendil-works/pi-coding-agent";
import type { ExactModelReference, ModelSelection } from "../shared/model.ts";

export interface HandoffRosterEntry extends ExactModelReference {
  /** The thinking levels this model may run at, or undefined for the agent's choice. */
  thinkingLevels: readonly ThinkingLevel[] | undefined;
}

export type HandoffRoster = readonly HandoffRosterEntry[];

/**
 * Chooses the roster a handoff selects from, in descending priority: an explicit
 * `sessions.handoff.roster`, the session's own scoped models (`enabledModels`),
 * then everything authenticated. The middle tier lets a curated model cycle
 * govern delegation too; the top tier exists for when the two should disagree.
 */
export function resolveHandoffRoster(options: {
  models: readonly Model<Api>[];
  patterns: readonly ModelSelection[];
  scopedModels: readonly ScopedModel[];
}): HandoffRoster | undefined {
  const configured = buildHandoffRoster(options.models, options.patterns);
  if (configured) {
    return configured;
  }
  return options.scopedModels.length > 0 ? options.scopedModels.map(scopedEntry) : undefined;
}

function scopedEntry(scoped: ScopedModel): HandoffRosterEntry {
  return {
    provider: scoped.model.provider,
    modelId: scoped.model.id,
    thinkingLevels: scoped.thinkingLevel ? [scoped.thinkingLevel] : undefined,
  };
}

/**
 * Expands configured roster patterns against the authenticated models. A roster
 * only ever narrows what a handoff may launch, so patterns that match nothing
 * are dropped rather than raised; the resulting roster is still safe, just
 * smaller. An unconfigured roster returns undefined, deferring to the next tier.
 */
export function buildHandoffRoster(
  models: readonly Model<Api>[],
  patterns: readonly ModelSelection[],
): HandoffRoster | undefined {
  if (patterns.length === 0) {
    return undefined;
  }

  const entries = new Map<string, HandoffRosterEntry>();
  for (const pattern of patterns) {
    const provider = globMatcher(pattern.provider);
    const modelId = globMatcher(pattern.modelId);
    for (const model of models) {
      if (!provider.test(model.provider) || !modelId.test(model.id)) {
        continue;
      }
      const key = `${model.provider}/${model.id}`;
      const existing = entries.get(key);
      entries.set(key, {
        provider: model.provider,
        modelId: model.id,
        thinkingLevels: mergeThinkingLevels(existing, pattern.thinkingLevel),
      });
    }
  }

  return [...entries.values()];
}

/**
 * Narrows a requested model to its roster entry. An entry listing a single
 * thinking level pins it, so the agent may leave the level out; an entry listing
 * several makes the choice mandatory.
 */
export function selectFromRoster(
  roster: HandoffRoster,
  requested: ExactModelReference,
  thinkingLevel: ThinkingLevel | undefined,
): ThinkingLevel | undefined {
  if (roster.length === 0) {
    throw new Error(
      "session_handoff cannot override the model: sessions.handoff.roster matches no authenticated model.",
    );
  }

  const entry = roster.find(
    (candidate) =>
      candidate.provider === requested.provider && candidate.modelId === requested.modelId,
  );
  if (!entry) {
    throw new Error(
      `Model "${requested.provider}/${requested.modelId}" is not on the handoff roster. Allowed models: ${formatRoster(roster)}.`,
    );
  }

  const allowed = entry.thinkingLevels;
  if (!allowed) {
    return thinkingLevel;
  }
  if (!thinkingLevel) {
    if (allowed.length > 1) {
      throw new Error(
        `The handoff roster requires a thinking level for "${formatEntryReference(entry)}": one of ${allowed.join(", ")}.`,
      );
    }
    return allowed[0];
  }
  if (!allowed.includes(thinkingLevel)) {
    throw new Error(
      `The handoff roster does not allow thinking level ${thinkingLevel} for "${formatEntryReference(entry)}"; allowed: ${allowed.join(", ")}.`,
    );
  }
  return thinkingLevel;
}

export function formatRoster(roster: HandoffRoster): string {
  return roster.map(formatRosterEntry).join(", ");
}

export function formatRosterEntry(entry: HandoffRosterEntry): string {
  const reference = formatEntryReference(entry);
  if (!entry.thinkingLevels) {
    return reference;
  }
  return entry.thinkingLevels.length === 1
    ? `${reference}:${entry.thinkingLevels[0]}`
    : `${reference}:{${entry.thinkingLevels.join(",")}}`;
}

function formatEntryReference(entry: ExactModelReference): string {
  return `${entry.provider}/${entry.modelId}`;
}

function mergeThinkingLevels(
  existing: HandoffRosterEntry | undefined,
  added: ThinkingLevel | undefined,
): readonly ThinkingLevel[] | undefined {
  if (!added) {
    return undefined;
  }
  if (!existing) {
    return [added];
  }
  if (!existing.thinkingLevels) {
    return undefined;
  }
  return existing.thinkingLevels.includes(added)
    ? existing.thinkingLevels
    : [...existing.thinkingLevels, added];
}

function globMatcher(pattern: string): RegExp {
  const source = pattern
    .split("*")
    .map((segment) => segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${source}$`);
}
