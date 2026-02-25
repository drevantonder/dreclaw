import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";
import { DEFAULT_BASE_URL } from "../types";

export interface ZenRuntimeConfig {
  model: string;
  baseUrl: string;
  apiKey: string;
}

export function createZenModel(runtime: ZenRuntimeConfig): LanguageModel {
  const provider = createOpenAICompatible({
    name: "opencode",
    apiKey: runtime.apiKey,
    baseURL: runtime.baseUrl || DEFAULT_BASE_URL,
  });
  return provider(runtime.model);
}
