import type { Api, Model } from "@earendil-works/pi-ai";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { fuzzyFilter } from "@earendil-works/pi-tui";

const MODEL_VALUE_POSITION = /(?:^|\s)--model\s+(\S*)$/;

export function getHandoffModelCompletions(
  argumentPrefix: string,
  models: readonly Model<Api>[],
): AutocompleteItem[] | null {
  const position = modelValuePosition(argumentPrefix);
  if (!position) {
    return null;
  }

  const filtered = fuzzyFilter([...models], position.partial, modelSearchText);
  if (filtered.length === 0) {
    return null;
  }

  return filtered.map((model) => ({
    value: `${position.leading}${model.provider}/${model.id}`,
    label: model.id,
    description: model.provider,
  }));
}

function modelValuePosition(text: string): { leading: string; partial: string } | null {
  const match = MODEL_VALUE_POSITION.exec(text);
  if (!match) {
    return null;
  }

  const partial = match[1] ?? "";
  return { leading: text.slice(0, text.length - partial.length), partial };
}

function modelSearchText(model: Model<Api>): string {
  return `${model.id} ${model.provider} ${model.provider}/${model.id}`;
}
