import { type Static, Type } from "typebox";
import { HANDOFF_LAUNCH_RECEIPT_SCHEMA } from "./receipt.ts";

export const HANDOFF_TOOL_DETAILS_SCHEMA = Type.Intersect([
  HANDOFF_LAUNCH_RECEIPT_SCHEMA,
  Type.Object({
    degradedFrom: Type.Optional(
      Type.Union([
        Type.Literal("left"),
        Type.Literal("right"),
        Type.Literal("up"),
        Type.Literal("down"),
      ]),
    ),
  }),
]);

export type HandoffToolDetails = Static<typeof HANDOFF_TOOL_DETAILS_SCHEMA>;
