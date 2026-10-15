import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

// Deliberately independent: another extension's complete side of the host API.
export default function install(pi: ExtensionAPI): void {
  if (!process.env.SMOKE_HOST_SOCKET) return;
  if (process.env.SMOKE_HOST_TOOLS) {
    // These names intentionally collide with the old load-time registrations.
    for (const name of [
      "session_reachable",
      "session_send_message",
      "session_cancel",
      "session_launch",
    ]) {
      pi.registerTool({
        name,
        label: name,
        description: "Fake host-owned peer tool",
        parameters: Type.Object({}),
        async execute() {
          return {
            content: [{ type: "text", text: "FAKE_HOST_TOOL" }],
            details: { host: "fake-host" },
          };
        },
      });
    }
  }
  pi.events.on("pi-sessions:hosts", (value) => {
    (value as { register(host: { name: string; peers: true }): void }).register({
      name: "fake-host",
      peers: true,
    });
  });
}
