export interface TurnMessage {
  customType: string;
  content: string;
  display: boolean;
  details: unknown;
}

export const TURN_MESSAGE_DELIVERY = { triggerTurn: true, deliverAs: "steer" } as const;

export interface TurnDeliverySession {
  isIdle(): boolean;
  /** Defined while a prompt is streaming. */
  readonly signal: AbortSignal | undefined;
}

const HELD_POLL_MS = 100;

/**
 * Delivers custom messages the session must act on. Pi steers them into a streaming prompt and
 * starts a turn for them on an idle session, but a session compacting or summarizing a branch
 * outside a prompt is neither: Pi only appends the message there, and starting a turn would race
 * the compaction. Such messages are held until the session can take them. Pi emits no event once
 * a standalone compaction has finished, so held messages poll.
 *
 * Every caller records its message durably before delivering it, so messages still held when the
 * session shuts down are dropped and replayed by the next session start.
 */
export class TurnMessageDelivery {
  private session: TurnDeliverySession | undefined;
  private held: TurnMessage[] = [];
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly send: (message: TurnMessage, options: typeof TURN_MESSAGE_DELIVERY) => void,
  ) {}

  bind(session: TurnDeliverySession): void {
    this.clear();
    this.session = session;
  }

  clear(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.held = [];
    this.session = undefined;
  }

  deliver(message: TurnMessage): void {
    if (!this.session) throw new Error("Target session is not ready.");
    this.held.push(message);
    if (!this.flush()) {
      this.timer ??= setInterval(() => this.flush(), HELD_POLL_MS);
      this.timer.unref();
    }
  }

  hasHeld(): boolean {
    return this.held.length > 0;
  }

  private flush(): boolean {
    const session = this.session;
    if (!session || !(session.isIdle() || session.signal)) return false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    const held = this.held;
    this.held = [];
    // After the first message starts a turn, Pi steers the rest into it.
    for (const message of held) this.send(message, TURN_MESSAGE_DELIVERY);
    return true;
  }
}
