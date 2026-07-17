import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { IncomingSessionMessageRuntime } from "./session-messaging/pi/incoming-runtime.ts";
import { registerSessionMessagingRenderer } from "./session-messaging/pi/renderer.ts";
import { SessionMessagingService } from "./session-messaging/pi/service.ts";
import { registerSessionMessagingTools } from "./session-messaging/pi/tools.ts";
import { loadSettings } from "./shared/settings.ts";

export default function sessionMessagingExtension(pi: ExtensionAPI): void {
  const settings = loadSettings();
  const incomingRuntime = new IncomingSessionMessageRuntime(pi);
  const service = new SessionMessagingService(settings.index.path, incomingRuntime);

  pi.on("session_start", async (_event, ctx) => {
    incomingRuntime.replayPending(ctx);
    try {
      await service.start(ctx);
    } catch {}
  });

  pi.on("session_shutdown", () => {
    service.stop();
  });

  registerSessionMessagingTools(pi, service);
  registerSessionMessagingRenderer(pi);
}
