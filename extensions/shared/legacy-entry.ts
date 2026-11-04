// Session files are durable and outlive renames: entries written before the snake_case tool
// rename still say goal, requestResponse, and nextSteps. Renaming on read keeps their subagents,
// bootstraps, handoff metadata, and reports parseable.
const LEGACY_KEYS: Record<string, string> = {
  goal: "briefing",
  requestResponse: "reportBack",
  nextSteps: "next_steps",
};

export function upgradeLegacyEntry(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, inner]) => [
      LEGACY_KEYS[key] ?? key,
      upgradeLegacyEntry(inner),
    ]),
  );
}
