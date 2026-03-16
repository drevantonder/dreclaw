import type { LanguageModel } from "ai";
import { createWorkersAI } from "workers-ai-provider";

export function createWorkersModel(binding: Ai, model: string): LanguageModel {
  const provider = createWorkersAI({ binding });
  return provider(model);
}
