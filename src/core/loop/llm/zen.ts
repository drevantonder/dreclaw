import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import { DEFAULT_BASE_URL } from "./constants";

export interface ZenRuntimeConfig {
  providerName?: string;
  model: string;
  baseUrl: string;
  apiKey: string;
}

export function createZenModel(runtime: ZenRuntimeConfig): LanguageModel {
  const provider = createOpenAICompatible({
    name: runtime.providerName || "opencode",
    apiKey: runtime.apiKey,
    baseURL: runtime.baseUrl || DEFAULT_BASE_URL,
  });
  return provider(runtime.model);
}
