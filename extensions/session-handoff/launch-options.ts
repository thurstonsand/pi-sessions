import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createDeferredLaunchBackend } from "./launch/deferred.ts";
import type { SplitLaunchBackend } from "./launch/resolution.ts";
import {
  createBackendLaunchTarget,
  DEFERRED_LAUNCH,
  type HandoffLaunchTarget,
  type HandoffLaunchValue,
  LAUNCH_DIRECTIONS,
} from "./launch-target.ts";

export interface ResolvedHandoffLaunchTarget {
  target: HandoffLaunchTarget;
  degradedFrom?: (typeof LAUNCH_DIRECTIONS)[number] | undefined;
}

export function createHandoffLaunchTargets(options: {
  pi: ExtensionAPI;
  splitBackend: SplitLaunchBackend | undefined;
  copyDeferredToClipboard: boolean;
  additionalTargets: readonly HandoffLaunchTarget[];
}): HandoffLaunchTarget[] {
  const splitBackend = options.splitBackend;
  const splitTargets = splitBackend
    ? LAUNCH_DIRECTIONS.map((direction, index) =>
        createBackendLaunchTarget(
          direction,
          splitBackend.create(direction),
          index === 0
            ? `direction values open a ${splitBackend.name} split. If the user does not make the launch target clear, ask for clarification.`
            : undefined,
        ),
      )
    : [];
  const deferred = createBackendLaunchTarget(
    DEFERRED_LAUNCH,
    createDeferredLaunchBackend({ copyToClipboard: options.copyDeferredToClipboard }),
    "'deferred' creates the session and returns its resume command without opening anything.",
  );
  return [...splitTargets, deferred, ...options.additionalTargets];
}

export function resolveHandoffLaunchTarget(
  requested: HandoffLaunchValue,
  targets: readonly HandoffLaunchTarget[],
): ResolvedHandoffLaunchTarget {
  const exact = targets.find((target) => target.value === requested);
  if (exact) {
    return { target: exact };
  }

  if (LAUNCH_DIRECTIONS.some((direction) => direction === requested)) {
    const deferred = targets.find((target) => target.value === DEFERRED_LAUNCH);
    if (!deferred) {
      throw new Error("Deferred handoff launch is unavailable.");
    }
    return { target: deferred, degradedFrom: requested as (typeof LAUNCH_DIRECTIONS)[number] };
  }

  throw new Error(`Handoff launch target is unavailable: ${requested}`);
}
