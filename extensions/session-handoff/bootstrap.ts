import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { ModelRuntimeProvider } from "../shared/model-runtime.ts";
import { generateHandoffDraftFromSessionManager } from "./extract.ts";
import { buildHandoffKickoffMessage, buildHandoffKickoffSource } from "./kickoff.ts";
import {
  type ChildGeneratedHandoffBootstrap,
  createHandoffSessionMetadata,
  findPendingHandoffBootstrap,
  getHandoffMetadataFromEntries,
  HANDOFF_BOOTSTRAP_CONSUMED_CUSTOM_TYPE,
  HANDOFF_METADATA_CUSTOM_TYPE,
  HANDOFF_STALE_SESSION_MESSAGE,
  type HandoffBootstrapConsumedReason,
  hasStartedConversation,
} from "./metadata.ts";
import { reviewHandoffDraftForSend } from "./review.ts";
import { formatHandoffError, runHandoffTaskWithLoader } from "./ui.ts";

export async function consumePendingHandoffBootstrap(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  getModelRuntime: ModelRuntimeProvider,
  thinkingLevel: ThinkingLevel | undefined,
): Promise<void> {
  const scan = findPendingHandoffBootstrap(ctx.sessionManager.getBranch());
  if (!scan) {
    return;
  }

  const consumeBootstrap = (reason: HandoffBootstrapConsumedReason): void => {
    pi.appendEntry(HANDOFF_BOOTSTRAP_CONSUMED_CUSTOM_TYPE, {
      bootstrapEntryId: scan.entryId,
      reason,
    });
  };

  if (scan.kind === "invalid") {
    consumeBootstrap("invalid");
    return;
  }

  const bootstrap = scan.bootstrap;
  if (bootstrap.sessionId !== ctx.sessionManager.getSessionId()) {
    consumeBootstrap("invalid");
    return;
  }

  await startChildGeneratedHandoff(
    pi,
    ctx,
    bootstrap,
    scan.entryId,
    consumeBootstrap,
    getModelRuntime,
    thinkingLevel,
  );
}

async function startChildGeneratedHandoff(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  bootstrap: ChildGeneratedHandoffBootstrap,
  bootstrapEntryId: string,
  consumeBootstrap: (reason: HandoffBootstrapConsumedReason) => void,
  getModelRuntime: ModelRuntimeProvider,
  thinkingLevel: ThinkingLevel | undefined,
): Promise<void> {
  const entries = ctx.sessionManager.getEntries();
  if (hasStartedConversation(entries)) {
    consumeBootstrap("stale");
    if (ctx.hasUI) {
      ctx.ui.notify(HANDOFF_STALE_SESSION_MESSAGE, "error");
    }
    return;
  }

  if (!ctx.hasUI) {
    if (bootstrap.bootstrapMode === "automatic") {
      ctx.shutdown();
    }
    return;
  }

  // A thrown error leaves the bootstrap pending so the next resume offers
  // review again; explicit user decisions consume it.
  try {
    const sourceSessionManager = SessionManager.open(bootstrap.parentSessionFile);
    const modelRuntime = await getModelRuntime(ctx.modelRegistry);
    const generatedDraft = await runHandoffTaskWithLoader(
      ctx,
      "Generating handoff draft...",
      async (signal: AbortSignal) =>
        generateHandoffDraftFromSessionManager(
          ctx,
          modelRuntime,
          sourceSessionManager,
          bootstrap.sourceLeafId,
          bootstrap.goal,
          thinkingLevel,
          signal,
          bootstrap.requestResponse,
        ),
    );
    if (!generatedDraft) {
      consumeBootstrap("cancelled");
      ctx.ui.notify("Cancelled", "info");
      return;
    }

    let prompt = generatedDraft.draft;
    if (bootstrap.bootstrapMode === "review") {
      const review = await reviewHandoffDraftForSend(ctx.ui, generatedDraft.draft);
      if (review.action === "prefill") {
        consumeBootstrap("prefilled");
        ctx.ui.setEditorText(review.prompt);
        ctx.ui.notify("Handoff prompt ready in editor.", "info");
        return;
      }
      if (review.action === "cancel") {
        consumeBootstrap("cancelled");
        ctx.ui.notify("Cancelled", "info");
        return;
      }
      prompt = review.prompt;
    }

    // The tool-provided bootstrap title is authoritative; extraction does not
    // replace it with a second generated title.
    const metadata = createHandoffSessionMetadata(bootstrap.goal, prompt, bootstrap.title);
    if (!getHandoffMetadataFromEntries(ctx.sessionManager.getEntries())) {
      pi.appendEntry(HANDOFF_METADATA_CUSTOM_TYPE, metadata);
    }
    pi.setSessionName(metadata.title);
    const sourceSessionName = sourceSessionManager.getSessionName();
    pi.sendMessage(
      buildHandoffKickoffMessage({
        prompt,
        title: metadata.title,
        source: buildHandoffKickoffSource({
          sessionId: sourceSessionManager.getSessionId(),
          ...(sourceSessionName ? { sessionName: sourceSessionName } : {}),
        }),
        bootstrapEntryId,
      }),
      { triggerTurn: true },
    );
  } catch (error) {
    ctx.ui.notify(formatHandoffError(error), "error");
    if (bootstrap.bootstrapMode === "automatic") {
      ctx.shutdown();
    }
  }
}
