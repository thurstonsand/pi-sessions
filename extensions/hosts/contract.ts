import { type Static, Type } from "typebox";

export const HOSTS_CHANNEL = "pi-sessions:hosts";
export const HOST_SCHEMA = Type.Object(
  {
    name: Type.String({ pattern: "^[a-z][a-z0-9-]*$" }),
    peers: Type.Literal(true),
    recall: Type.Optional(Type.Literal(true)),
  },
  { additionalProperties: false },
);

export type Host = Static<typeof HOST_SCHEMA>;
export interface HostRegistrationRequest {
  register(host: Host): void;
}
