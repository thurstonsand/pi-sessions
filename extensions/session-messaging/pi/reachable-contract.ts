import { type Static, Type } from "typebox";

const SCOPE_SCHEMA = Type.Union([
  Type.Literal("user"),
  Type.Literal("branch"),
  Type.Literal("tree"),
]);

/** Registered when subagents are active; the roster is what makes branch/tree answerable. */
export const SESSION_REACHABLE_PARAMS = Type.Object({
  scope: Type.Optional(
    Type.Union([Type.Literal("user"), Type.Literal("branch"), Type.Literal("tree")], {
      description:
        'Which sessions to list: "user" for live user-facing sessions, "branch" for subagents launched from the active conversation branch, "tree" for subagents launched anywhere in this session\'s conversation tree. Defaults to "user".',
    }),
  ),
});

/** Registered when subagents are inactive; only live user sessions can ever be returned. */
export const SESSION_REACHABLE_USER_PARAMS = Type.Object({});

const REACHABLE_USER_SESSION_SCHEMA = Type.Object({
  kind: Type.Literal("user"),
  sessionId: Type.String(),
  title: Type.Optional(Type.String()),
  cwd: Type.Optional(Type.String()),
  modifiedAt: Type.Optional(Type.String()),
  relation: Type.Optional(Type.String()),
  state: Type.Union([Type.Literal("live"), Type.Literal("starting")]),
});

const REACHABLE_SUBAGENT_SCHEMA = Type.Object({
  kind: Type.Literal("subagent"),
  sessionId: Type.String(),
  title: Type.String(),
  goal: Type.String(),
  cwd: Type.String(),
  state: Type.String(),
  depth: Type.Number(),
  onActiveBranch: Type.Boolean(),
  launchedAt: Type.String(),
  model: Type.Optional(Type.String()),
  ownerSessionId: Type.String(),
  ownerTitle: Type.String(),
  ownerIsCurrentSession: Type.Boolean(),
  resumeCommand: Type.String(),
});

export const SESSION_REACHABLE_TOOL_DETAILS_SCHEMA = Type.Object({
  scope: SCOPE_SCHEMA,
  sessions: Type.Array(Type.Union([REACHABLE_USER_SESSION_SCHEMA, REACHABLE_SUBAGENT_SCHEMA])),
});

export type SessionReachableScope = Static<typeof SCOPE_SCHEMA>;
export type SessionReachableParams = Static<typeof SESSION_REACHABLE_PARAMS>;
export type ReachableUserSession = Static<typeof REACHABLE_USER_SESSION_SCHEMA>;
export type ReachableSubagent = Static<typeof REACHABLE_SUBAGENT_SCHEMA>;
export type ReachableSession = ReachableUserSession | ReachableSubagent;
export type SessionReachableToolDetails = Static<typeof SESSION_REACHABLE_TOOL_DETAILS_SCHEMA>;
