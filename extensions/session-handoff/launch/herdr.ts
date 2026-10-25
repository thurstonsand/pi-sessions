import { type HerdrSession, splitHerdrPane } from "../../shared/herdr.ts";
import type { HandoffSplitDirection, LaunchBackend, LaunchInput } from "./backend.ts";

export function createHerdrSplitLaunchBackend(
  session: HerdrSession,
  direction: HandoffSplitDirection,
): LaunchBackend {
  return {
    name: "Herdr",
    async launch(input: LaunchInput) {
      await splitHerdrPane(session, { direction, cwd: input.cwd, command: input.resumeCommand });
      return { success: true };
    },
  };
}
