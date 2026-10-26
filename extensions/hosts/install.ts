import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";

/** Defer recall tools until discovery, without removing a host's load-time definitions. */
export function installRecallTool<TParams extends TSchema, TDetails>(
  pi: ExtensionAPI,
  claimsRecall: () => boolean,
  tool: ToolDefinition<TParams, TDetails>,
): { refresh(): void } {
  let registered = false;
  return {
    refresh() {
      if (claimsRecall()) {
        // Pi has no unregisterTool; retained definitions must also reject execution.
        if (registered) pi.setActiveTools(pi.getActiveTools().filter((name) => name !== tool.name));
        return;
      }
      if (!registered) {
        pi.registerTool({
          ...tool,
          execute: async (...args) => {
            if (claimsRecall()) throw new Error("Recall tools belong to the current host.");
            return tool.execute(...args);
          },
        });
        registered = true;
      }
      pi.setActiveTools([...new Set([...pi.getActiveTools(), tool.name])]);
    },
  };
}
