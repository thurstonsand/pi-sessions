import { type Static, Type } from "typebox";

export const LINEAGE_CUSTOM_TYPE = "pi-sessions.lineage";
export const LINEAGE_SCHEMA = Type.Object({
  parentSessionId: Type.String({ minLength: 1 }),
  parentSessionFile: Type.Optional(Type.String({ minLength: 1 })),
});
export type SessionLineage = Static<typeof LINEAGE_SCHEMA>;
