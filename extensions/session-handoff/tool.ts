import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { resolveHandoffSource } from "./extract.ts";
import type { ClipboardStatus } from "./launch/backend.ts";
import { createDeferredLaunchBackend } from "./launch/deferred.ts";
import {
  createGhosttyLaunchBackend,
  type HandoffSplitDirection,
  isGhosttyHandoffAvailable,
} from "./launch/ghostty.ts";
import { createChildGeneratedHandoffBootstrap } from "./metadata.ts";
import { formatModelArgument, resolveModelOverride } from "./model.ts";
import { buildLaunchReceipt } from "./receipt.ts";
import { prepareHandoffLaunch } from "./spawn.ts";
import type { HandoffToolDetails } from "./tool-contract.ts";

const NO_IDENTIFIED_TERMINAL_MESSAGE =
  "No Ghostty source terminal identified. Run /handoff --identify from the intended source pane.";

export const LAUNCH_DIRECTIONS = ["left", "right", "up", "down"] as const;
export const DEFERRED_LAUNCH = "deferred" as const;

export type HandoffLaunchTarget = HandoffSplitDirection | typeof DEFERRED_LAUNCH;

export interface HandoffToolParams {
  goal: string;
  title: string;
  launch: HandoffLaunchTarget;
  cwd?: string | undefined;
  requestResponse?: boolean | undefined;
  model?: string | undefined;
  thinkingLevel?: ThinkingLevel | undefined;
}

export async function executeSessionHandoffTool(
  pi: ExtensionAPI,
  params: HandoffToolParams,
  ctx: ExtensionContext,
  modelRuntime: ModelRuntime,
  terminalId: string | undefined,
  copyToClipboardSetting: boolean,
  recordClipboardStatus: (sessionId: string, status: ClipboardStatus) => void,
) {
  const goal = params.goal.trim();
  if (!goal) {
    throw new Error("session_handoff requires a goal.");
  }

  const title = params.title.trim();
  if (!title) {
    throw new Error("session_handoff requires a title.");
  }

  if (!ctx.model) {
    throw new Error("No model selected.");
  }

  const direction = params.launch === DEFERRED_LAUNCH ? undefined : params.launch;
  const useGhostty = direction !== undefined && isGhosttyHandoffAvailable();
  const degradedFrom = direction !== undefined && !useGhostty ? direction : undefined;

  if (useGhostty && !terminalId) {
    throw new Error(NO_IDENTIFIED_TERMINAL_MESSAGE);
  }

  const targetCwd = resolveHandoffCwd(ctx.cwd, params.cwd);
  if (targetCwd.error) {
    throw new Error(targetCwd.message);
  }

  const parentSessionFile = ctx.sessionManager.getSessionFile();
  if (!parentSessionFile) {
    throw new Error("Handoff requires a persisted current session.");
  }

  // Tools execute in parallel, so the leaf is still the invoking assistant turn; its parent is the
  // last settled entry. Anchoring there keeps the launch receipt this handoff produces out of the snapshot.
  const invocationLeafId = ctx.sessionManager.getLeafId();
  const sourceLeafId = invocationLeafId
    ? ctx.sessionManager.getEntry(invocationLeafId)?.parentId
    : undefined;
  if (!sourceLeafId) {
    throw new Error("No conversation to hand off.");
  }

  resolveHandoffSource(ctx.sessionManager, sourceLeafId);

  const requestResponse = params.requestResponse ?? false;
  const override = params.model
    ? resolveModelOverride(modelRuntime, params.model, params.thinkingLevel)
    : undefined;
  const model = formatModelArgument(
    override?.model ?? ctx.model,
    override?.thinkingLevel ?? params.thinkingLevel ?? pi.getThinkingLevel(),
  );
  if (!model) {
    throw new Error("No active model is available for the handoff.");
  }
  const prepared = prepareHandoffLaunch({
    targetCwd: targetCwd.path,
    parentCwd: ctx.cwd,
    parentSessionDir: ctx.sessionManager.getSessionDir(),
    parentSessionFile,
    title,
    model,
    buildBootstrap: (sessionId) =>
      createChildGeneratedHandoffBootstrap({
        sessionId,
        goal,
        title,
        parentSessionFile,
        sourceLeafId,
        requestResponse,
      }),
  });
  const backend =
    useGhostty && direction !== undefined
      ? createGhosttyLaunchBackend(pi, { direction, terminalId })
      : createDeferredLaunchBackend({ copyToClipboard: copyToClipboardSetting });
  const outcome = await backend.launch({
    cwd: targetCwd.path,
    title,
    resumeCommand: prepared.resumeCommand,
  });

  if (!outcome.success) {
    throw new Error(
      `${outcome.error} Created handoff session ${prepared.sessionId}; start it manually with: ${prepared.resumeCommand}`,
    );
  }
  if (outcome.clipboardStatus) {
    recordClipboardStatus(prepared.sessionId, outcome.clipboardStatus);
  }

  const effectiveLaunch: HandoffLaunchTarget =
    useGhostty && direction !== undefined ? direction : DEFERRED_LAUNCH;
  const details: HandoffToolDetails = {
    ...buildLaunchReceipt({
      sessionId: prepared.sessionId,
      title,
      launch: effectiveLaunch,
      resumeCommand: prepared.resumeCommand,
      backend: effectiveLaunch === DEFERRED_LAUNCH ? undefined : "Ghostty",
      targetCwd: targetCwd.path,
      parentCwd: ctx.cwd,
      childModel: model,
    }),
    ...(degradedFrom ? { degradedFrom } : {}),
  };

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ ...details, requestResponse }, null, 2),
      },
    ],
    details,
  };
}

function resolveHandoffCwd(
  currentCwd: string,
  requestedCwd: string | undefined,
): { path: string; error?: undefined } | { error: true; message: string } {
  const rawPath = requestedCwd?.trim();
  const resolvedPath = rawPath ? resolveRequestedPath(currentCwd, rawPath) : currentCwd;

  if (!existsSync(resolvedPath)) {
    return { error: true, message: `Handoff cwd does not exist: ${resolvedPath}` };
  }
  if (!statSync(resolvedPath).isDirectory()) {
    return { error: true, message: `Handoff cwd is not a directory: ${resolvedPath}` };
  }
  return { path: resolvedPath };
}

function resolveRequestedPath(currentCwd: string, requestedPath: string): string {
  if (requestedPath === "~") {
    return homedir();
  }
  if (requestedPath.startsWith("~/")) {
    return resolve(homedir(), requestedPath.slice(2));
  }
  if (isAbsolute(requestedPath)) {
    return requestedPath;
  }
  return resolve(currentCwd, requestedPath);
}
