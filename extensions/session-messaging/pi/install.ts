import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SessionDirectory } from "../directory.ts";
import { createDirectoryTools } from "./directory-tools.ts";
import { SESSION_REACHABLE_PARAMS, SESSION_REACHABLE_USER_PARAMS } from "./reachable-contract.ts";

export function installDirectoryTools(
  pi: ExtensionAPI,
  deps: {
    peers: SessionDirectory;
    subagents?: SessionDirectory;
    claimsPeers(): boolean;
  },
): { refresh(): void } {
  const ownedPeerNames = new Set<string>();
  const refresh = (): void => {
    const parentSessionId = deps.peers.getParentSessionId();
    if (deps.claimsPeers()) {
      // Pi has no unregisterTool. Remove only definitions we installed from the model's
      // loadout, not a host's load-time tools. Retained definitions are execution-guarded.
      pi.setActiveTools(pi.getActiveTools().filter((name) => !ownedPeerNames.has(name)));
    } else {
      const tools = createDirectoryTools(deps.peers, {
        list: {
          name: "session_reachable",
          description: "List live user-facing Pi sessions.",
          promptSnippet: "Find live peer sessions",
          promptGuidelines: [],
          parameters: SESSION_REACHABLE_USER_PARAMS,
          defaultScope: "user",
        },
        send: {
          name: "session_send_message",
          description: "Send a message to another live Pi session.",
          promptSnippet: "Message a live peer",
          promptGuidelines: [
            "Use session_reachable to find the target.",
            ...(parentSessionId
              ? ["Report to your parent with submit_task_report, never peer messaging."]
              : []),
          ],
        },
        cancel: {
          name: "session_cancel",
          description: "Cancel another live Pi session's turn.",
          promptSnippet: "Cancel a peer turn",
          promptGuidelines: [
            "Only cancel a user session when the user directs it.",
            ...(parentSessionId ? ["Never cancel your parent session."] : []),
          ],
        },
      });
      for (const tool of tools) {
        ownedPeerNames.add(tool.name);
        pi.registerTool({
          ...tool,
          execute: async (...args) => {
            if (deps.claimsPeers()) throw new Error("Peer tools belong to the current host.");
            return tool.execute(...args);
          },
        });
      }
      pi.setActiveTools([...new Set([...pi.getActiveTools(), ...ownedPeerNames])]);
    }
    if (deps.subagents) {
      const tools = createDirectoryTools(deps.subagents, {
        list: {
          name: "subagent_list",
          description: "List owned subagents in the branch or tree.",
          promptSnippet: "Find delegated subagents",
          promptGuidelines: [],
          parameters: SESSION_REACHABLE_PARAMS,
          defaultScope: "branch",
        },
        send: {
          name: "subagent_send",
          description: parentSessionId
            ? "Send a message to another subagent; dormant owned workers wake automatically."
            : "Send a message to a subagent; dormant owned workers wake automatically.",
          promptSnippet: "Steer or follow up with a subagent",
          promptGuidelines: [
            "Use subagent_list to find the target.",
            ...(parentSessionId
              ? ["Report to your parent with submit_task_report, not subagent_send."]
              : []),
          ],
        },
        cancel: {
          name: "subagent_cancel",
          description: "Stop a subagent.",
          promptSnippet: "Cancel delegated work",
          promptGuidelines: parentSessionId
            ? ["Never cancel your parent session; it is waiting on your report."]
            : [],
        },
      });
      for (const tool of tools) pi.registerTool(tool);
      pi.setActiveTools([...new Set([...pi.getActiveTools(), ...tools.map((tool) => tool.name)])]);
    }
  };
  pi.on("session_tree", refresh);
  return { refresh };
}
