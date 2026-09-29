import { runAgent } from "../ask";
import type { AskModel } from "../../../shared/types/agents";

/** It reads every provider's catalog before it prints. */
const LIST_TIMEOUT_MS = 15_000;

/**
 * The rows of `pi --list-models`' table as `provider/model`, what `--model` takes; nothing without
 * its header row, which pi prints only when it has a model to list.
 */
export function piModelsFrom(output: string): AskModel[] {
  const lines = output.split(/\r?\n/);
  const header = lines.findIndex((line) => /^provider\s+model\b/.test(line.trim()));
  if (header === -1) {
    return [];
  }
  return lines.slice(header + 1).flatMap((line) => {
    const [provider, model] = line.trim().split(/\s+/);
    if (!provider || !model) {
      return [];
    }
    const id = `${provider}/${model}`;
    return [{ id, label: id }];
  });
}

export async function listPiModels(executable: string, cwd: string): Promise<AskModel[]> {
  return piModelsFrom(await runAgent("pi", executable, cwd, ["--list-models"], LIST_TIMEOUT_MS));
}
