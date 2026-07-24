import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { resolveHandoffSource } from "./extract.ts";
import type { ClipboardStatus } from "./launch/backend.ts";
import { resolveHandoffLaunchTarget } from "./launch-options.ts";
import {
  DEFERRED_LAUNCH,
  type HandoffLaunchTarget,
  type HandoffLaunchValue,
} from "./launch-target.ts";
import { createChildGeneratedHandoffBootstrap } from "./metadata.ts";
import { formatModelArgument, resolveModelOverride } from "./model.ts";
import { buildLaunchReceipt } from "./receipt.ts";
import { formatHandoffLaunchFailure, prepareHandoffLaunch } from "./spawn.ts";
import type { HandoffToolDetails } from "./tool-contract.ts";

export type { HandoffLaunchValue } from "./launch-target.ts";
export { DEFERRED_LAUNCH, LAUNCH_DIRECTIONS, SUBAGENT_LAUNCH } from "./launch-target.ts";

export const MAX_HANDOFF_TITLE_LENGTH = 64;

export interface HandoffToolParams {
  goal: string;
  title: string;
  launch: HandoffLaunchValue;
  cwd?: string | undefined;
  requestResponse?: boolean | undefined;
  provider?: string | undefined;
  model?: string | undefined;
  thinkingLevel?: ThinkingLevel | undefined;
}

export async function executeSessionHandoffTool(
  pi: ExtensionAPI,
  params: HandoffToolParams,
  ctx: ExtensionContext,
  modelRuntime: ModelRuntime,
  launchTargets: readonly HandoffLaunchTarget[],
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
  if ([...title].length > MAX_HANDOFF_TITLE_LENGTH) {
    throw new Error("session_handoff title must be 64 characters or less.");
  }

  if (!ctx.model) {
    throw new Error("No model selected.");
  }

  const { target, degradedFrom } = resolveHandoffLaunchTarget(params.launch, launchTargets);

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

  const requestResponse = params.requestResponse ?? target.requestResponseDefault;
  const provider = params.provider?.trim();
  const modelId = params.model?.trim();
  if (Boolean(provider) !== Boolean(modelId)) {
    throw new Error("session_handoff requires provider and model together, or neither.");
  }
  const override =
    provider && modelId
      ? resolveModelOverride(modelRuntime, `${provider}/${modelId}`, params.thinkingLevel)
      : undefined;
  const childModel = override?.model ?? ctx.model;
  const thinkingLevel = override?.thinkingLevel ?? params.thinkingLevel ?? pi.getThinkingLevel();
  const model = formatModelArgument(childModel, thinkingLevel);
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
        bootstrapMode: target.bootstrapMode,
        launch: target.value,
        subagent: target.describeSubagentChild?.({
          childSessionId: sessionId,
          ownerSessionId: ctx.sessionManager.getSessionId(),
          requestResponse,
        }),
      }),
    prepareChild: (manager, childSessionId) =>
      target.prepareChild({
        manager,
        childSessionId,
        parentSessionId: ctx.sessionManager.getSessionId(),
        parentSessionFile,
        requestResponse,
      }),
  });
  const outcome = await target.launch({
    prepared,
    parentSessionId: ctx.sessionManager.getSessionId(),
    title,
    goal,
    requestResponse,
    model,
    cwd: targetCwd.path,
  });

  if (!outcome.success) {
    throw new Error(formatHandoffLaunchFailure(outcome.error, prepared));
  }
  if (outcome.clipboardStatus) {
    recordClipboardStatus(prepared.sessionId, outcome.clipboardStatus);
  }

  const details: HandoffToolDetails = {
    ...buildLaunchReceipt({
      sessionId: prepared.sessionId,
      childSessionFile: prepared.sessionFile,
      title,
      launch: target.value,
      resumeCommand: prepared.resumeCommand,
      backend: target.value === DEFERRED_LAUNCH ? undefined : outcome.backend,
      targetCwd: targetCwd.path,
      parentCwd: ctx.cwd,
      childModel: model,
      childProvider: childModel.provider,
      childModelName: childModel.name || childModel.id,
      thinkingLevel,
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
