import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

// Without a renderCall, Pi prints every argument on the call row; these tools' result rows
// already show what matters, so the call row is just the tool name.
export function renderToolNameCall(name: string) {
  return (_args: unknown, theme: Theme): Text =>
    new Text(theme.fg("toolTitle", theme.bold(name)), 0, 0);
}
