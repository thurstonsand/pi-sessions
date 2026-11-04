import { type Static, Type } from "typebox";

const SCOPE_SCHEMA = Type.Union([
  Type.Literal("user"),
  Type.Literal("branch"),
  Type.Literal("tree"),
]);

/** Registered when subagents are active; the roster is what makes branch/tree answerable. */
export const SESSION_LIST_PARAMS = Type.Object({
  scope: Type.Optional(
    Type.Union([Type.Literal("branch"), Type.Literal("tree")], {
      description:
        '"branch" lists subagents from the active conversation branch; "tree" lists subagents anywhere in this session\'s conversation tree. Defaults to "branch".',
    }),
  ),
});

/** Registered when subagents are inactive; only live user sessions can ever be returned. */
export const SESSION_LIST_USER_PARAMS = Type.Object({});

const LISTED_USER_SESSION_SCHEMA = Type.Object({
  kind: Type.Literal("user"),
  session_id: Type.String(),
  title: Type.Optional(Type.String()),
  cwd: Type.Optional(Type.String()),
  modified_at: Type.Optional(Type.String()),
  relation: Type.Optional(Type.String()),
  state: Type.Union([Type.Literal("live"), Type.Literal("starting")]),
});

const LISTED_SUBAGENT_SCHEMA = Type.Object({
  kind: Type.Literal("subagent"),
  session_id: Type.String(),
  title: Type.String(),
  briefing: Type.String(),
  cwd: Type.String(),
  state: Type.String(),
  depth: Type.Number(),
  on_active_branch: Type.Boolean(),
  launched_at: Type.String(),
  model: Type.Optional(Type.String()),
  owner_session_id: Type.String(),
  owner_title: Type.String(),
  owner_is_current_session: Type.Boolean(),
  resume_command: Type.String(),
});

export const SESSION_LIST_TOOL_DETAILS_SCHEMA = Type.Object({
  scope: SCOPE_SCHEMA,
  sessions: Type.Array(Type.Union([LISTED_USER_SESSION_SCHEMA, LISTED_SUBAGENT_SCHEMA])),
});

export type SessionListScope = Static<typeof SCOPE_SCHEMA>;
export type SessionListParams = Static<typeof SESSION_LIST_PARAMS>;
export type ListedUserSession = Static<typeof LISTED_USER_SESSION_SCHEMA>;
export type ListedSubagent = Static<typeof LISTED_SUBAGENT_SCHEMA>;
export type ListedSession = ListedUserSession | ListedSubagent;
export type SessionListToolDetails = Static<typeof SESSION_LIST_TOOL_DETAILS_SCHEMA>;
