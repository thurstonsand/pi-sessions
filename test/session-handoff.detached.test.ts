import { beforeEach, describe, expect, it, vi } from "vitest";

const mockCopyToClipboard = vi.fn();

vi.mock("@earendil-works/pi-coding-agent", () => ({
  copyToClipboard: mockCopyToClipboard,
}));

const { createDetachedLaunchBackend } = await import(
  "../extensions/session-handoff/launch/detached.ts"
);

beforeEach(() => {
  vi.clearAllMocks();
  mockCopyToClipboard.mockResolvedValue(undefined);
});

describe("detached launch backend", () => {
  it("copies the resume command and returns it as the outcome message", async () => {
    const backend = createDetachedLaunchBackend({ copyToClipboard: true });

    const outcome = await backend.launch({
      cwd: "/tmp/project",
      title: "Session handoff",
      resumeCommand: "RESUME child-1",
    });

    expect(mockCopyToClipboard).toHaveBeenCalledWith("RESUME child-1");
    expect(outcome).toEqual({ success: true });
  });

  it("skips the clipboard when copying is disabled", async () => {
    const backend = createDetachedLaunchBackend({ copyToClipboard: false });

    const outcome = await backend.launch({
      cwd: "/tmp/project",
      title: "Session handoff",
      resumeCommand: "RESUME child-1",
    });

    expect(mockCopyToClipboard).not.toHaveBeenCalled();
    expect(outcome).toEqual({ success: true });
  });

  it("succeeds even when the clipboard copy fails", async () => {
    mockCopyToClipboard.mockRejectedValue(new Error("no clipboard"));
    const backend = createDetachedLaunchBackend({ copyToClipboard: true });

    const outcome = await backend.launch({
      cwd: "/tmp/project",
      title: "Session handoff",
      resumeCommand: "RESUME child-1",
    });

    expect(outcome).toEqual({ success: true });
  });
});
