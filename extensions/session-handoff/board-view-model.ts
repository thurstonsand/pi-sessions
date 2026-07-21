import { tmuxSessionName } from "../shared/tmux.ts";
import type { SubagentState } from "../subagents/classify.ts";
import type { SubagentRosterEntry } from "../subagents/roster.ts";
import { shellQuote } from "./launch/shell.ts";
import type { HandoffLaunchReceipt } from "./receipt.ts";

const RUNNING_SUBAGENT_STATES: ReadonlySet<SubagentState> = new Set(["starting", "busy", "active"]);

export type HandoffBoardTab = "subagents" | "user-sessions";
export type UserSessionStatus = "live" | "ready" | "starting" | "closed" | "unknown";

export interface UserSessionRunEvidence {
  transcriptAvailable: boolean;
  hasStarted: boolean;
}

export interface UserSessionEntry {
  sessionId: string;
  timestamp: string;
  receipt: HandoffLaunchReceipt;
  runEvidence?: UserSessionRunEvidence | undefined;
}

export interface HandoffBoardSnapshot {
  subagents: readonly SubagentRosterEntry[];
  userSessions: readonly UserSessionEntry[];
  liveSessionIds: ReadonlySet<string>;
  hasLiveSessionEvidence: boolean;
}

export interface HandoffBoardDetail {
  label: string;
  value: string;
}

export interface HandoffBoardAction {
  subagent?: SubagentRosterEntry | undefined;
  canStop: boolean;
  observeCommand?: string | undefined;
  resumeCommand?: string | undefined;
}

export interface HandoffSubagentRow {
  kind: "subagent";
  title: string;
  depth: number;
  status: SubagentState;
  timestamp: string;
}

export interface UserSessionRow {
  kind: "user-session";
  title: string;
  status: UserSessionStatus;
  timestamp: string;
}

export interface HandoffSubagentsView {
  tab: "subagents";
  rows: readonly HandoffSubagentRow[];
  details: readonly HandoffBoardDetail[];
  action?: HandoffBoardAction | undefined;
}

export interface UserSessionsView {
  tab: "user-sessions";
  rows: readonly UserSessionRow[];
  details: readonly HandoffBoardDetail[];
  action?: HandoffBoardAction | undefined;
}

export type HandoffBoardView = HandoffSubagentsView | UserSessionsView;

export function buildHandoffBoardView(
  snapshot: HandoffBoardSnapshot,
  tab: HandoffBoardTab,
  selectedIndex: number,
  options: { insideTmux: boolean },
): HandoffBoardView {
  if (tab === "subagents") {
    const selected = snapshot.subagents[selectedIndex];
    return {
      tab,
      rows: snapshot.subagents.map((subagent) => ({
        kind: "subagent",
        title: subagent.title,
        depth: subagent.depth,
        status: subagent.state,
        timestamp: subagent.launchedAt,
      })),
      details: selected
        ? [
            { label: "Session", value: selected.sessionId },
            { label: "Model", value: selected.model ?? "Default" },
            {
              label: "Owner",
              value: selected.ownerIsCurrentSession ? "this session" : selected.ownerTitle,
            },
            { label: "Goal", value: selected.goal },
          ]
        : [],
      ...(selected ? { action: buildSubagentAction(selected, options.insideTmux) } : {}),
    };
  }

  const rows = snapshot.userSessions.map(
    (entry): UserSessionRow => ({
      kind: "user-session",
      title: entry.receipt.title,
      status: getUserSessionStatus(snapshot, entry),
      timestamp: entry.timestamp,
    }),
  );
  const selected = snapshot.userSessions[selectedIndex];
  if (!selected) {
    return { tab, rows, details: [] };
  }

  const details: HandoffBoardDetail[] = [
    { label: "Session", value: selected.sessionId },
    { label: "Model", value: selected.receipt.model },
    { label: "Launch", value: selected.receipt.launch },
  ];
  if (selected.receipt.backend) {
    details.push({ label: "Backend", value: selected.receipt.backend });
  }
  if (selected.receipt.cwd) {
    details.push({ label: "Directory", value: selected.receipt.cwd });
  }
  const action = buildUserSessionAction(snapshot, selected);
  return {
    tab,
    rows,
    details,
    ...(action ? { action } : {}),
  };
}

function getUserSessionStatus(
  snapshot: HandoffBoardSnapshot,
  entry: UserSessionEntry,
): UserSessionStatus {
  if (snapshot.liveSessionIds.has(entry.sessionId)) {
    return "live";
  }
  const evidence = entry.runEvidence;
  if (!evidence?.transcriptAvailable) {
    return "unknown";
  }
  if (evidence.hasStarted) {
    return snapshot.hasLiveSessionEvidence ? "closed" : "unknown";
  }
  return entry.receipt.launch === "deferred" ? "ready" : "starting";
}

function buildUserSessionAction(
  snapshot: HandoffBoardSnapshot,
  entry: UserSessionEntry,
): HandoffBoardAction | undefined {
  if (!snapshot.hasLiveSessionEvidence || snapshot.liveSessionIds.has(entry.sessionId)) {
    return undefined;
  }
  return {
    canStop: false,
    resumeCommand: entry.receipt.resumeCommand,
  };
}

function buildSubagentAction(entry: SubagentRosterEntry, insideTmux: boolean): HandoffBoardAction {
  return {
    subagent: entry,
    canStop: RUNNING_SUBAGENT_STATES.has(entry.state),
    ...(entry.tmuxWindowId ? { observeCommand: buildObserveCommand(entry, insideTmux) } : {}),
    ...(!entry.managedLive ? { resumeCommand: entry.resumeCommand } : {}),
  };
}

function buildObserveCommand(entry: SubagentRosterEntry, insideTmux: boolean): string {
  const target = shellQuote(`${tmuxSessionName(entry.ownerSessionId)}:${entry.tmuxWindowId}`);
  return insideTmux ? `tmux switch-client -t ${target}` : `tmux attach-session -t ${target}`;
}
