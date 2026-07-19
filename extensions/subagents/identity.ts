import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { safeParseTypeBoxValue } from "../shared/typebox.ts";

export const SUBAGENT_IDENTITY_CUSTOM_TYPE = "pi-sessions.subagent";

export const SUBAGENT_IDENTITY_SCHEMA = Type.Object({
  childSessionId: Type.String(),
  ownerSessionId: Type.String(),
  parentSessionFile: Type.String(),
  depth: Type.Integer({ minimum: 1 }),
  requestResponse: Type.Boolean(),
});

export type SubagentIdentity = Static<typeof SUBAGENT_IDENTITY_SCHEMA>;

export function findSubagentIdentity(
  entries: readonly SessionEntry[],
  currentSessionId: string,
): SubagentIdentity | undefined {
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== SUBAGENT_IDENTITY_CUSTOM_TYPE) {
      continue;
    }
    const identity = safeParseTypeBoxValue(SUBAGENT_IDENTITY_SCHEMA, entry.data);
    if (identity?.childSessionId === currentSessionId) {
      return identity;
    }
  }
  return undefined;
}
