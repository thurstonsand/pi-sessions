import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { SendMessageRequest, SendMessageResult } from "../session-messaging/install.ts";
import {
  createTmuxWindow,
  killTmuxWindow,
  listTmuxWindows,
  type TmuxExecutor,
  tmuxSessionName,
} from "../shared/tmux.ts";
import { findOwnedSubagentLaunch, type SubagentLaunched } from "./ledger.ts";

const SESSION_READY_TIMEOUT_MS = 30_000;

export interface WakeParentSession {
  sessionId: string;
  epoch: number;
  getBranch(): readonly SessionEntry[];
}

interface WakeMessaging {
  sendMessage(request: SendMessageRequest): Promise<SendMessageResult>;
  listSessions(): Promise<string[]>;
  waitForSession(sessionId: string, timeoutMs: number): Promise<boolean>;
}

export interface SubagentMessageRouterOptions {
  readyTimeoutMs?: number;
  onMaterialize?(launch: SubagentLaunched): void;
  afterOwnedSend?(): Promise<void> | void;
}

export class SubagentMessageRouter {
  private readonly wakeBySessionId = new Map<string, Promise<void>>();

  constructor(
    private readonly executor: TmuxExecutor,
    private readonly messaging: WakeMessaging,
    private readonly getParent: () => WakeParentSession | undefined,
    private readonly isCurrent: (epoch: number) => boolean,
    private readonly options: SubagentMessageRouterOptions = {},
  ) {}

  async sendMessage(request: SendMessageRequest): Promise<SendMessageResult> {
    let failedLiveSend: SendMessageResult | undefined;
    if (await this.isLive(request.target)) {
      const result = await this.messaging.sendMessage(request);
      if (result.delivered || !isTargetDeparture(result)) {
        return result;
      }
      failedLiveSend = result;
    }

    const parent = this.getParent();
    const launch = parent
      ? findOwnedSubagentLaunch(parent.getBranch(), parent.sessionId, request.target)
      : undefined;
    if (!parent || !launch) {
      return failedLiveSend ?? this.messaging.sendMessage(request);
    }

    try {
      await this.wake(parent, launch);
      const result = await this.sendOwned(parent, request);
      if (result.delivered || !isTargetDeparture(result)) {
        return result;
      }

      await this.wake(parent, launch);
      return this.sendOwned(parent, request);
    } finally {
      await this.options.afterOwnedSend?.();
    }
  }

  private async wake(parent: WakeParentSession, launch: SubagentLaunched): Promise<void> {
    const existing = this.wakeBySessionId.get(launch.childSessionId);
    if (existing) {
      return existing;
    }

    const wake = this.ensureReady(parent, launch).finally(() => {
      if (this.wakeBySessionId.get(launch.childSessionId) === wake) {
        this.wakeBySessionId.delete(launch.childSessionId);
      }
    });
    this.wakeBySessionId.set(launch.childSessionId, wake);
    return wake;
  }

  private async ensureReady(parent: WakeParentSession, launch: SubagentLaunched): Promise<void> {
    if (await this.isLive(launch.childSessionId)) {
      return;
    }

    const tmuxSession = tmuxSessionName(parent.sessionId);
    const hasWindow = (await listTmuxWindows(this.executor, tmuxSession)).some(
      (window) => window.piSessionId === launch.childSessionId,
    );

    if (!hasWindow) {
      await this.createWindow(parent, launch, tmuxSession);
    }
    if (
      await this.messaging.waitForSession(
        launch.childSessionId,
        this.options.readyTimeoutMs ?? SESSION_READY_TIMEOUT_MS,
      )
    ) {
      return;
    }

    this.requireCurrent(parent);
    const killed = await killTmuxWindow(this.executor, tmuxSession, launch.childSessionId);
    if (!killed) {
      throw new Error(
        `Subagent ${launch.childSessionId} did not register and its stale tmux window could not be stopped.`,
      );
    }

    await this.createWindow(parent, launch, tmuxSession);
    if (
      !(await this.messaging.waitForSession(
        launch.childSessionId,
        this.options.readyTimeoutMs ?? SESSION_READY_TIMEOUT_MS,
      ))
    ) {
      throw new Error(
        `Subagent ${launch.childSessionId} was restarted but did not register for messaging.`,
      );
    }
  }

  private async createWindow(
    parent: WakeParentSession,
    launch: SubagentLaunched,
    tmuxSession: string,
  ): Promise<void> {
    if (await this.isLive(launch.childSessionId)) {
      return;
    }
    this.requireCurrent(parent);
    this.options.onMaterialize?.(launch);
    await createTmuxWindow(this.executor, {
      tmuxSession,
      name: launch.title,
      cwd: launch.cwd,
      command: launch.resumeCommand,
      piSessionId: launch.childSessionId,
    });
  }

  private sendOwned(
    parent: WakeParentSession,
    request: SendMessageRequest,
  ): Promise<SendMessageResult> {
    this.requireCurrent(parent);
    return this.messaging.sendMessage(request);
  }

  private async isLive(sessionId: string): Promise<boolean> {
    return (await this.messaging.listSessions()).includes(sessionId);
  }

  private requireCurrent(parent: WakeParentSession): void {
    if (!this.isCurrent(parent.epoch)) {
      throw new Error("The parent session changed while waking its subagent.");
    }
  }
}

function isTargetDeparture(result: SendMessageResult): boolean {
  return !result.delivered && (result.reason === "no_session" || result.reason === "disconnected");
}
