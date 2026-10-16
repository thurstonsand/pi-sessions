import { afterEach, describe, expect, it, vi } from "vitest";
import { TurnMessageDelivery } from "../extensions/shared/turn-delivery.ts";

function message(customType: string) {
  return { customType, content: customType, display: true, details: undefined };
}

describe("turn message delivery", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("holds messages through a standalone compaction and starts a turn once idle", async () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const session = { idle: false, signal: undefined as AbortSignal | undefined };
    const delivery = new TurnMessageDelivery(send);
    delivery.bind({ isIdle: () => session.idle, signal: undefined });

    delivery.deliver(message("first"));
    delivery.deliver(message("second"));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(send).not.toHaveBeenCalled();
    expect(delivery.hasHeld()).toBe(true);

    session.idle = true;
    await vi.advanceTimersByTimeAsync(100);
    expect(send.mock.calls).toEqual([
      [message("first"), { triggerTurn: true, deliverAs: "steer" }],
      [message("second"), { triggerTurn: true, deliverAs: "steer" }],
    ]);
    expect(delivery.hasHeld()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("hands messages to Pi at once while idle or streaming a prompt", () => {
    const send = vi.fn();
    const delivery = new TurnMessageDelivery(send);
    delivery.bind({ isIdle: () => false, signal: new AbortController().signal });

    delivery.deliver(message("steered"));

    expect(send).toHaveBeenCalledExactlyOnceWith(message("steered"), {
      triggerTurn: true,
      deliverAs: "steer",
    });
    expect(delivery.hasHeld()).toBe(false);
  });

  it("drops held messages when the session shuts down", async () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const delivery = new TurnMessageDelivery(send);
    delivery.bind({ isIdle: () => false, signal: undefined });
    delivery.deliver(message("held"));

    delivery.clear();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(send).not.toHaveBeenCalled();
    expect(delivery.hasHeld()).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});
