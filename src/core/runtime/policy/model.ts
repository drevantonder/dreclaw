import type { RuntimeDeps } from "../../app/types";
import type { BotThreadState } from "../../loop/state";
import { FIREWORKS_BASE_URL, OPENCODE_GO_BASE_URL, OPENCODE_ZEN_BASE_URL } from "../llm/constants";
import { createWorkersModel } from "../llm/workers";
import { createZenModel } from "../llm/zen";
import {
  findModelCatalogEntry,
  getDefaultModelCatalogEntry,
  listModelAliases,
} from "./model-catalog";

export { findModelCatalogEntry } from "./model-catalog";

export type RuntimeConfig =
  | { provider: "workers"; model: string; aiBinding: Ai }
  | {
      provider: "opencode" | "opencode-go" | "fireworks";
      providerName: "opencode" | "fireworks";
      model: string;
      apiKey: string;
      baseUrl: string;
    };

export const DEFAULT_RUN_TIMEOUT_MS = 25_000;

export function getRuntimeConfig(
  deps: RuntimeDeps,
  state?: Pick<BotThreadState, "modelAlias"> | null,
): RuntimeConfig {
  const selected = findModelCatalogEntry(state?.modelAlias) ?? getDefaultModelCatalogEntry();
  const provider =
    selected.provider ||
    ((deps.AI_PROVIDER?.trim().toLowerCase() || "opencode") as
      | "opencode"
      | "opencode-go"
      | "fireworks"
      | "workers");
  const model =
    selected.model ||
    deps.MODEL?.trim() ||
    (provider === "workers" ? "@cf/zai-org/glm-4.7-flash" : "");
  if (!model) throw new Error("Missing MODEL");
  if (provider === "workers") {
    if (!deps.AI) throw new Error("Missing AI binding");
    return { provider, model, aiBinding: deps.AI };
  }
  const apiKey =
    provider === "fireworks" ? deps.FIREWORKS_API_KEY?.trim() : deps.OPENCODE_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      provider === "fireworks" ? "Missing FIREWORKS_API_KEY" : "Missing OPENCODE_API_KEY",
    );
  }
  return {
    provider,
    providerName: provider === "fireworks" ? "fireworks" : "opencode",
    model,
    apiKey,
    baseUrl:
      provider === "fireworks"
        ? deps.FIREWORKS_BASE_URL?.trim() || FIREWORKS_BASE_URL
        : deps.BASE_URL?.trim() ||
          (provider === "opencode-go" ? OPENCODE_GO_BASE_URL : OPENCODE_ZEN_BASE_URL),
  };
}

export function getRuntimeAlias(state?: Pick<BotThreadState, "modelAlias"> | null): string {
  return (findModelCatalogEntry(state?.modelAlias) ?? getDefaultModelCatalogEntry()).alias;
}

export function listRuntimeAliases(): string[] {
  return listModelAliases();
}

export function createRuntimeModel(runtime: RuntimeConfig) {
  return runtime.provider === "workers"
    ? createWorkersModel(runtime.aiBinding, runtime.model)
    : createZenModel({
        providerName: runtime.providerName,
        model: runtime.model,
        apiKey: runtime.apiKey,
        baseUrl: runtime.baseUrl,
      });
}

export function getAgentProviderOptions(
  runtime: RuntimeConfig,
  configuredReasoningEffort?: string,
): Record<string, Record<string, string | number | boolean | null>> | undefined {
  if (runtime.provider === "workers") return undefined;
  const extraOptions =
    runtime.provider === "fireworks" ? getFireworksProviderOptions(runtime.model) : {};
  return {
    [runtime.providerName]: {
      reasoningEffort: getReasoningEffort(configuredReasoningEffort, runtime),
      ...extraOptions,
    },
  };
}

export function getReasoningEffort(
  configured: string | undefined,
  runtime: Exclude<RuntimeConfig, { provider: "workers" }>,
): string {
  const trimmed = configured?.trim();
  if (trimmed) return trimmed;
  if (runtime.provider !== "fireworks") return "medium";

  const model = runtime.model.toLowerCase();
  if (model.includes("kimi-k2p5")) return "none";
  if (model.includes("minimax-m2p5")) return "low";
  return "medium";
}

export function getFireworksProviderOptions(
  model: string,
): Record<string, string | number | boolean | null> {
  const lower = model.toLowerCase();
  if (lower.includes("kimi-k2p5")) {
    return {
      reasoning_history: "interleaved",
      prompt_truncate_len: 12000,
    };
  }
  if (lower.includes("minimax-m2p5")) {
    return {
      prompt_truncate_len: 12000,
    };
  }
  return {};
}

export function getMaxOutputTokens(
  runtime: RuntimeConfig,
  mode: "conversation" | "reminder" | "recovery",
): number | undefined {
  if (runtime.provider !== "fireworks") return undefined;
  const lower = runtime.model.toLowerCase();
  if (lower.includes("kimi-k2p5")) {
    if (mode === "conversation") return 192;
    if (mode === "reminder") return 160;
    return 128;
  }
  if (lower.includes("minimax-m2p5")) {
    if (mode === "conversation") return 256;
    if (mode === "reminder") return 192;
    return 128;
  }
  return undefined;
}

export function getRunTimeoutMs(userText: string): number {
  const text = String(userText ?? "").toLowerCase();
  if (/gmail|email|inbox|calendar|drive|docs|sheets|google/.test(text)) {
    return 22_000;
  }
  return DEFAULT_RUN_TIMEOUT_MS;
}

export function getRunSliceSteps(value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1) return 4;
  return Math.min(12, Math.floor(parsed));
}

export function getTypingPulseMs(value: string | undefined): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 500) return 2500;
  return Math.floor(parsed);
}
