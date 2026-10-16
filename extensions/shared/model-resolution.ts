import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import { modelsAreEqual } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { resolveCliModel } from "@earendil-works/pi-coding-agent";

export type AuthenticatedModelResolution =
  | {
      ok: true;
      model: Model<Api>;
      thinkingLevel: ThinkingLevel | undefined;
      warning: string | undefined;
    }
  | {
      ok: false;
      error: string;
      warning: string | undefined;
    };

/**
 * Resolves a model pattern with Pi's CLI grammar (fuzzy aliases, slash ids,
 * `:thinking` suffixes), then narrows the result to a fresh entry from the
 * runtime's available snapshot. resolveCliModel intentionally searches every
 * model for CLI setup flows; nested extension work must only run activated,
 * authenticated models, and the available object crosses that boundary.
 */
export function resolveAuthenticatedModel(options: {
  modelRuntime: ModelRuntime;
  modelPattern: string;
  thinkingLevel?: ThinkingLevel | undefined;
}): AuthenticatedModelResolution {
  const resolved = resolvePattern(options);
  const available = options.modelRuntime.getAvailableSnapshot();
  if (resolved.model) {
    const model = findAvailable(available, resolved.model);
    if (!model) {
      return {
        ok: false,
        error: `Model "${resolved.model.provider}/${resolved.model.id}" is not an available authenticated model.`,
        warning: resolved.warning,
      };
    }
    return {
      ok: true,
      model,
      thinkingLevel: options.thinkingLevel ?? resolved.thinkingLevel,
      warning: resolved.warning,
    };
  }

  // Pi words its failures for the CLI (--provider, --list-models), with no structured reason.
  // Resolving within each authenticated provider tells an ambiguous pattern from an unknown one.
  const candidates = [...new Set(available.map((model) => model.provider))].flatMap((provider) => {
    const within = resolvePattern({ ...options, provider });
    const model = within.model && findAvailable(available, within.model);
    return model ? [{ model, thinkingLevel: options.thinkingLevel ?? within.thinkingLevel }] : [];
  });
  const [only] = candidates;
  if (only && candidates.length === 1) {
    return { ok: true, ...only, warning: undefined };
  }
  if (candidates.length > 1) {
    const matches = candidates
      .map(({ model }) => `${model.provider}/${model.id}`)
      .sort((a, b) => a.localeCompare(b))
      .join(", ");
    return {
      ok: false,
      error: `Model "${options.modelPattern}" is ambiguous across providers: ${matches}. Use provider/model.`,
      warning: undefined,
    };
  }
  return {
    ok: false,
    error: `Model "${options.modelPattern}" not found.`,
    warning: resolved.warning,
  };
}

function resolvePattern(options: {
  modelRuntime: ModelRuntime;
  modelPattern: string;
  thinkingLevel?: ThinkingLevel | undefined;
  provider?: string;
}) {
  return resolveCliModel({
    cliModel: options.modelPattern,
    ...(options.provider ? { cliProvider: options.provider } : {}),
    ...(options.thinkingLevel ? { cliThinking: options.thinkingLevel } : {}),
    modelRuntime: options.modelRuntime,
  });
}

function findAvailable(
  available: readonly Model<Api>[],
  model: Model<Api>,
): Model<Api> | undefined {
  return available.find((candidate) => modelsAreEqual(candidate, model));
}

export function formatAvailableModelList(models: readonly Model<Api>[]): string {
  return models.map((model) => `${model.provider}/${model.id}`).join(", ");
}
