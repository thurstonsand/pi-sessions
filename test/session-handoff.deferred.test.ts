import { beforeEach, describe, expect, it, vi } from "vitest";

const mockCopyToClipboard = vi.fn();

vi.mock("@earendil-works/pi-coding-agent", () => ({
  copyToClipboard: mockCopyToClipboard,
}));

const { createDeferredLaunchBackend } = await import(
  "../extensions/session-handoff/launch/deferred.ts"
);

beforeEach(() => {
  vi.clearAllMocks();
  mockCopyToClipboard.mockResolvedValue(undefined);
});

describe("deferred launch backend", () => {
  it("reports a successful clipboard copy", async () => {
    const backend = createDeferredLaunchBackend({ copyToClipboard: true });

    const outcome = await backend.launch({
      cwd: "/tmp/project",
      title: "Session handoff",
      resumeCommand: "RESUME child-1",
    });

    expect(mockCopyToClipboard).toHaveBeenCalledWith("RESUME child-1");
    expect(outcome).toEqual({ success: true, clipboardStatus: "copied" });
  });

  it("skips the clipboard when copying is disabled", async () => {
    const backend = createDeferredLaunchBackend({ copyToClipboard: false });

    const outcome = await backend.launch({
      cwd: "/tmp/project",
      title: "Session handoff",
      resumeCommand: "RESUME child-1",
    });

    expect(mockCopyToClipboard).not.toHaveBeenCalled();
    expect(outcome).toEqual({ success: true });
  });

  it("reports clipboard failure without failing the launch", async () => {
    mockCopyToClipboard.mockRejectedValue(new Error("no clipboard"));
    const backend = createDeferredLaunchBackend({ copyToClipboard: true });

    const outcome = await backend.launch({
      cwd: "/tmp/project",
      title: "Session handoff",
      resumeCommand: "RESUME child-1",
    });

    expect(outcome).toEqual({ success: true, clipboardStatus: "failed" });
  });
});
