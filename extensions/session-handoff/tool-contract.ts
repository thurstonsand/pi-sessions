import { type Static, Type } from "typebox";
import { HANDOFF_DIRECTION_LAUNCH_SCHEMA } from "./launch-target.ts";
import { HANDOFF_LAUNCH_RECEIPT_SCHEMA } from "./receipt.ts";

export const HANDOFF_TOOL_DETAILS_SCHEMA = Type.Intersect([
  HANDOFF_LAUNCH_RECEIPT_SCHEMA,
  Type.Object({
    degradedFrom: Type.Optional(HANDOFF_DIRECTION_LAUNCH_SCHEMA),
  }),
]);

export type HandoffToolDetails = Static<typeof HANDOFF_TOOL_DETAILS_SCHEMA>;
