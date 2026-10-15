import type { SendMessageRequest, SendMessageResult } from "./install.ts";

export interface SessionWaker {
  owns(target: string): boolean | Promise<boolean>;
  wake(target: string): Promise<void>;
  restart?(target: string): Promise<void>;
  afterSend?(): Promise<void> | void;
}

export interface WakeMessaging {
  sendMessage(request: SendMessageRequest): Promise<SendMessageResult>;
  listSessions(): Promise<string[]>;
  waitForSession(sessionId: string, timeoutMs: number): Promise<boolean>;
}

export class MessageRouter {
  private readonly waking = new Map<string, Promise<void>>();

  constructor(
    private readonly messaging: WakeMessaging,
    private readonly getWaker: () => SessionWaker | undefined,
    private readonly getEpoch: () => number,
    private readonly readyTimeoutMs = 30_000,
  ) {}

  async sendMessage(request: SendMessageRequest): Promise<SendMessageResult> {
    const epoch = this.getEpoch();
    let failedLiveSend: SendMessageResult | undefined;
    if (await this.isLive(request.target)) {
      this.requireCurrent(epoch);
      const result = await this.messaging.sendMessage(request);
      if (!isTargetDeparture(result)) return result;
      failedLiveSend = result;
    }
    const waker = this.getWaker();
    const owner = waker && (await waker.owns(request.target)) ? waker : undefined;
    this.requireCurrent(epoch);
    if (!owner) return failedLiveSend ?? this.messaging.sendMessage(request);

    try {
      for (let attempt = 0; ; attempt += 1) {
        await this.wake(request.target, owner, epoch);
        this.requireCurrent(epoch);
        const result = await this.messaging.sendMessage(request);
        if (attempt === 1 || !isTargetDeparture(result)) return result;
      }
    } finally {
      if (epoch === this.getEpoch()) await owner.afterSend?.();
    }
  }

  private wake(target: string, waker: SessionWaker, epoch: number): Promise<void> {
    const key = `${epoch}:${target}`;
    const existing = this.waking.get(key);
    if (existing) return existing;
    const wake = this.ensureReady(target, waker, epoch).finally(() => this.waking.delete(key));
    this.waking.set(key, wake);
    return wake;
  }

  private async ensureReady(target: string, waker: SessionWaker, epoch: number): Promise<void> {
    if (await this.isLive(target)) return;
    this.requireCurrent(epoch);
    await waker.wake(target);
    if (await this.messaging.waitForSession(target, this.readyTimeoutMs)) return;
    this.requireCurrent(epoch);
    if (waker.restart) {
      await waker.restart(target);
      if (await this.messaging.waitForSession(target, this.readyTimeoutMs)) return;
    }
    throw new Error(`Session ${target} did not register for messaging.`);
  }

  private async isLive(target: string): Promise<boolean> {
    return (await this.messaging.listSessions()).includes(target);
  }

  private requireCurrent(epoch: number): void {
    if (epoch !== this.getEpoch())
      throw new Error("The current session changed while waking a session.");
  }
}

function isTargetDeparture(result: SendMessageResult): boolean {
  return !result.delivered && (result.reason === "no_session" || result.reason === "disconnected");
}
