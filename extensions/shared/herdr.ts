import { connect } from "node:net";
import { getShellConfig, SettingsManager } from "@earendil-works/pi-coding-agent";
import { type TSchema, Type } from "typebox";
import { parseTypeBoxValue } from "./typebox.ts";

const HERDR_TIMEOUT_MS = 15_000;
const TOKEN_SOURCE = "pi-sessions";
const OWNER_TOKEN = "pi_owner_session_id";
const SESSION_TOKEN = "pi_session_id";

const RESPONSE_SCHEMA = Type.Union([
  Type.Object({ result: Type.Unknown() }),
  Type.Object({ error: Type.Object({ code: Type.String(), message: Type.String() }) }),
]);
const PANE_SCHEMA = Type.Object({
  pane_id: Type.String(),
  workspace_id: Type.String(),
  tab_id: Type.String(),
  focused: Type.Boolean(),
  tokens: Type.Optional(Type.Union([Type.Record(Type.String(), Type.String()), Type.Null()])),
});
const PANE_INFO_SCHEMA = Type.Object({ type: Type.Literal("pane_info"), pane: PANE_SCHEMA });
const PANE_LIST_SCHEMA = Type.Object({
  type: Type.Literal("pane_list"),
  panes: Type.Array(PANE_SCHEMA),
});
const LAYOUT_APPLY_SCHEMA = Type.Object({
  type: Type.Literal("layout_apply"),
  layout: Type.Object({ tab_id: Type.String(), root: Type.Object({ pane_id: Type.String() }) }),
});

export class HerdrRequestError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface HerdrClient {
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
}

/** The Herdr pane this process runs in. */
export interface HerdrSession {
  client: HerdrClient;
  paneId: string;
}

export interface HerdrWorkerPane {
  paneId: string;
  tabId: string;
  focused: boolean;
  piSessionId: string;
}

export interface CreateHerdrWorkerOptions {
  ownerSessionId: string;
  name: string;
  cwd: string;
  command: string;
  piSessionId: string;
}

export type HerdrSplitDirection = "left" | "right" | "up" | "down";

/** One newline-delimited JSON request per connection, as the Herdr CLI does. */
export function createHerdrSocketClient(socketPath: string): HerdrClient {
  return {
    request(method, params) {
      return new Promise((resolve, reject) => {
        const socket = connect(socketPath);
        let buffer = "";
        socket.setEncoding("utf8");
        socket.setTimeout(HERDR_TIMEOUT_MS, () => {
          socket.destroy(new Error(`Herdr did not answer ${method} within ${HERDR_TIMEOUT_MS}ms.`));
        });
        socket.on("connect", () => {
          socket.write(`${JSON.stringify({ id: `pi-sessions:${method}`, method, params })}\n`);
        });
        socket.on("data", (chunk: string) => {
          buffer += chunk;
          const end = buffer.indexOf("\n");
          if (end === -1) return;
          socket.end();
          try {
            resolve(readResult(method, JSON.parse(buffer.slice(0, end))));
          } catch (error) {
            reject(error);
          }
        });
        socket.on("error", reject);
        socket.on("close", () => {
          reject(new Error(`Herdr closed the connection before answering ${method}.`));
        });
      });
    },
  };
}

/**
 * Resolves only when Herdr still knows this process's pane. A pane inherited from a Herdr that
 * has since exited, or one it no longer knows, leaves the session to its other backends.
 */
export async function resolveHerdrSession(
  env: NodeJS.ProcessEnv = process.env,
): Promise<HerdrSession | undefined> {
  if (env.HERDR_ENV !== "1" || !env.HERDR_SOCKET_PATH || !env.HERDR_PANE_ID) {
    return undefined;
  }
  // On Windows the socket path is only Herdr's claim file; Herdr listens on the named pipe beside it.
  const endpoint =
    process.platform === "win32" ? `\\\\.\\pipe\\${env.HERDR_SOCKET_PATH}` : env.HERDR_SOCKET_PATH;
  const session = {
    client: createHerdrSocketClient(endpoint),
    paneId: env.HERDR_PANE_ID,
  };
  try {
    await getPane(session.client, session.paneId);
    return session;
  } catch (error) {
    if (isUnreachable(error) || isPaneNotFound(error)) {
      return undefined;
    }
    throw error;
  }
}

export async function listHerdrWorkers(
  client: HerdrClient,
  ownerSessionId: string,
): Promise<HerdrWorkerPane[]> {
  const { panes } = parse(PANE_LIST_SCHEMA, await client.request("pane.list", {}), "pane.list");
  return panes.flatMap((pane) => {
    const piSessionId = pane.tokens?.[SESSION_TOKEN];
    return pane.tokens?.[OWNER_TOKEN] === ownerSessionId && piSessionId
      ? [{ paneId: pane.pane_id, tabId: pane.tab_id, focused: pane.focused, piSessionId }]
      : [];
  });
}

const pendingCreations = new Map<string, Promise<unknown>>();

// Creating a worker is check-then-act, and a wake can race a reconcile restoring the same child.
// Only the owner's process creates its workers, so serializing here keeps one pane per child.
export async function createHerdrWorker(
  session: HerdrSession,
  options: CreateHerdrWorkerOptions,
): Promise<HerdrWorkerPane> {
  const preceding = pendingCreations.get(options.ownerSessionId) ?? Promise.resolve();
  const creation = preceding.catch(() => {}).then(() => createWorker(session, options));
  pendingCreations.set(options.ownerSessionId, creation);
  try {
    return await creation;
  } finally {
    if (pendingCreations.get(options.ownerSessionId) === creation) {
      pendingCreations.delete(options.ownerSessionId);
    }
  }
}

async function createWorker(
  session: HerdrSession,
  options: CreateHerdrWorkerOptions,
): Promise<HerdrWorkerPane> {
  const { client } = session;
  const existing = (await listHerdrWorkers(client, options.ownerSessionId)).find(
    (pane) => pane.piSessionId === options.piSessionId,
  );
  if (existing) {
    return existing;
  }

  // The owner's pane can move between workspaces, so its launch-time HERDR_WORKSPACE_ID can be stale.
  const owner = await getPane(client, session.paneId);
  // Herdr runs the argv as is. Pi's own shell for its bash tool is Git Bash on Windows.
  const shell = getShellConfig(SettingsManager.create(options.cwd).getShellPath());
  const applied = parse(
    LAYOUT_APPLY_SCHEMA,
    await client.request("layout.apply", {
      workspace_id: owner.workspace_id,
      tab_label: options.name,
      focus: false,
      root: {
        type: "pane",
        label: options.name,
        cwd: options.cwd,
        command: [shell.shell, ...shell.args, options.command],
      },
    }),
    "layout.apply",
  );
  const paneId = applied.layout.root.pane_id;
  try {
    await client.request("pane.report_metadata", {
      pane_id: paneId,
      source: TOKEN_SOURCE,
      tokens: { [OWNER_TOKEN]: options.ownerSessionId, [SESSION_TOKEN]: options.piSessionId },
    });
  } catch (error) {
    await client.request("pane.close", { pane_id: paneId }).catch(() => {});
    throw error;
  }
  return { paneId, tabId: applied.layout.tab_id, focused: false, piSessionId: options.piSessionId };
}

export async function closeHerdrWorker(
  client: HerdrClient,
  ownerSessionId: string,
  piSessionId: string,
): Promise<boolean> {
  const panes = await listHerdrWorkers(client, ownerSessionId);
  for (const pane of panes.filter((candidate) => candidate.piSessionId === piSessionId)) {
    await closePane(client, pane.paneId);
  }
  return !(await listHerdrWorkers(client, ownerSessionId)).some(
    (pane) => pane.piSessionId === piSessionId,
  );
}

export async function closeHerdrWorkers(
  client: HerdrClient,
  ownerSessionId: string,
): Promise<boolean> {
  for (const pane of await listHerdrWorkers(client, ownerSessionId)) {
    await closePane(client, pane.paneId);
  }
  return (await listHerdrWorkers(client, ownerSessionId)).length === 0;
}

/** Splits this process's pane and types the command into the new pane's shell. */
export async function splitHerdrPane(
  session: HerdrSession,
  options: { direction: HerdrSplitDirection; cwd: string; command: string },
): Promise<void> {
  const { client } = session;
  const before = options.direction === "left" || options.direction === "up";
  const split = parse(
    PANE_INFO_SCHEMA,
    await client.request("pane.split", {
      target_pane_id: session.paneId,
      direction: options.direction === "left" || options.direction === "right" ? "right" : "down",
      cwd: options.cwd,
      focus: false,
    }),
    "pane.split",
  );
  const paneId = split.pane.pane_id;
  // Herdr only splits right or down. Swapping from the owner's side keeps the owner focused.
  if (before) {
    await client.request("pane.swap", { source_pane_id: session.paneId, target_pane_id: paneId });
  }
  await client.request("pane.send_input", {
    pane_id: paneId,
    text: options.command,
    keys: ["Enter"],
  });
}

async function getPane(client: HerdrClient, paneId: string) {
  return parse(PANE_INFO_SCHEMA, await client.request("pane.get", { pane_id: paneId }), "pane.get")
    .pane;
}

// The pane's command can exit between listing and closing it.
async function closePane(client: HerdrClient, paneId: string): Promise<void> {
  try {
    await client.request("pane.close", { pane_id: paneId });
  } catch (error) {
    if (!isPaneNotFound(error)) {
      throw error;
    }
  }
}

function readResult(method: string, value: unknown): unknown {
  const response = parseTypeBoxValue(RESPONSE_SCHEMA, value, `Invalid Herdr ${method} response`);
  if ("error" in response) {
    throw new HerdrRequestError(
      response.error.code,
      `Herdr ${method} failed: ${response.error.message}`,
    );
  }
  return response.result;
}

function parse<T extends TSchema>(schema: T, value: unknown, method: string) {
  return parseTypeBoxValue(schema, value, `Invalid Herdr ${method} result`);
}

function isPaneNotFound(error: unknown): boolean {
  return error instanceof HerdrRequestError && error.code === "pane_not_found";
}

function isUnreachable(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ECONNREFUSED";
}
