import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type JsonObject,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { contentToText } from "../../extensions/shared/text.ts";
import { parseTypeBoxValue } from "../../extensions/shared/typebox.ts";

const TOOL_REQUEST = Type.Object({
  tool: Type.String(),
  args: Type.Unsafe<JsonObject>({ type: "object", additionalProperties: true }),
});

export default function install(pi: ExtensionAPI): void {
  const faux = fauxProvider({
    api: "smoke",
    provider: "smoke",
    models: [{ id: "scripted", contextWindow: 200_000, maxTokens: 4096 }],
    tokensPerSecond: 1_000_000,
  });

  async function respond(context: TranscriptContext) {
    faux.appendResponses([respond]);
    const last = context.messages.at(-1);
    const tools = getCurrentTools(context.messages);
    if (last?.role === "toolResult") {
      return fauxAssistantMessage(last.isError ? "SMOKE_TOOL_ERROR" : "SMOKE_TURN_DONE");
    }
    if (tools.some((tool) => tool.name === "create_handoff_context")) {
      return fauxAssistantMessage(
        fauxToolCall("create_handoff_context", {
          summary: "Credential-free smoke task. Report SMOKE_REPORT to the parent.",
          relevantFiles: [],
        }),
      );
    }
    if (tools.some((tool) => tool.name === "submit_task_report")) {
      // What the worker's model actually received, for checking an agent profile's effect.
      appendFileSync(
        join(getAgentDir(), "worker-model-view.jsonl"),
        `${JSON.stringify({
          systemPrompt: getCurrentSystemPrompt(context.messages),
          tools: tools.map((tool) => tool.name),
        })}\n`,
      );
      const deadline = Date.now() + 30_000;
      while (!existsSync(join(getAgentDir(), "release-worker"))) {
        if (Date.now() > deadline) throw new Error("Smoke worker was never released.");
        await delay(50);
      }
      return fauxAssistantMessage(
        fauxToolCall("submit_task_report", { status: "done", summary: "SMOKE_REPORT" }),
      );
    }
    const text = contentToText(last?.content);
    if (text.startsWith("{")) {
      const request = parseTypeBoxValue(TOOL_REQUEST, JSON.parse(text), "Invalid smoke request");
      return fauxAssistantMessage(fauxToolCall(request.tool, request.args));
    }
    return fauxAssistantMessage("SMOKE_ACK");
  }

  faux.setResponses([respond]);
  pi.registerProvider({
    ...faux.provider,
    auth: { apiKey: { name: "Smoke", resolve: async () => ({ auth: { apiKey: "smoke" } }) } },
  });
  pi.on("session_start", async (_event, ctx) => {
    const model = ctx.modelRegistry.find("smoke", "scripted");
    if (!model) throw new Error("Smoke provider model is not registered.");
    await ctx.modelRegistry.refresh({ allowNetwork: false });
    if (!(await pi.setModel(model))) throw new Error("Smoke provider auth is unavailable.");
    const sessionId = ctx.sessionManager.getSessionId();
    writeFileSync(
      join(getAgentDir(), `${sessionId}.ready.json`),
      JSON.stringify({
        sessionId,
        sessionFile: ctx.sessionManager.getSessionFile(),
        cwd: ctx.cwd,
        pid: process.pid,
        agentDir: getAgentDir(),
        packageEntry: pi.getCommands().find((command) => command.name === "session-index")
          ?.sourceInfo.path,
        tools: pi.getAllTools().map((tool) => tool.name),
      }),
    );
  });
  pi.registerCommand("smoke-quit", {
    description: "Shut down this disposable smoke process",
    handler: async (_args, ctx) => ctx.shutdown(),
  });
  pi.on("before_agent_start", (_event, ctx) => {
    writeFileSync(
      join(getAgentDir(), `${ctx.sessionManager.getSessionId()}.tools.json`),
      JSON.stringify(pi.getAllTools()),
    );
  });
}
