export interface ActiveSessionBrokerConnection {
  listSessionIds(): Promise<string[]>;
}

let activeConnection: ActiveSessionBrokerConnection | undefined;

export function setActiveSessionBrokerConnection(
  connection: ActiveSessionBrokerConnection | undefined,
): void {
  activeConnection = connection;
}

export function getActiveSessionBrokerConnection(): ActiveSessionBrokerConnection | undefined {
  return activeConnection;
}
