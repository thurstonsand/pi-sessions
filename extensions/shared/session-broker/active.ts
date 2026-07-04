export interface ActiveSessionBrokerConnection {
  listSessionIds(): Promise<string[]>;
}

// Pi loads extension entrypoints through separate jiti module graphs, so module-local
// singletons are not shared between session-messaging and session-search. The process
// global is the only way to share a single connection
const ACTIVE_CONNECTION_KEY = Symbol.for("pi-sessions.active-session-broker-connection");

type ActiveConnectionGlobal = typeof globalThis & {
  [ACTIVE_CONNECTION_KEY]?: ActiveSessionBrokerConnection | undefined;
};

function getActiveConnectionGlobal(): ActiveConnectionGlobal {
  return globalThis as ActiveConnectionGlobal;
}

export function setActiveSessionBrokerConnection(
  connection: ActiveSessionBrokerConnection | undefined,
): void {
  getActiveConnectionGlobal()[ACTIVE_CONNECTION_KEY] = connection;
}

export function getActiveSessionBrokerConnection(): ActiveSessionBrokerConnection | undefined {
  return getActiveConnectionGlobal()[ACTIVE_CONNECTION_KEY];
}
