import { createMemoryRuntime } from "../memory";
import type { RuntimeDeps } from "../app/types";
import { compactErrorMessage } from "./tracing";

export interface MemoryGateway {
  getConfigSafe(): ReturnType<ReturnType<typeof createMemoryRuntime>["getConfig"]>;
  renderContext(params: {
    chatId: number;
    query: string;
    factTopK: number;
    episodeTopK: number;
  }): Promise<string>;
  find(params: { chatId: number; payload: unknown }): Promise<unknown>;
  save(params: { chatId: number; payload: unknown }): Promise<unknown>;
  remove(params: { chatId: number; payload: unknown }): Promise<unknown>;
  persistTurn(params: {
    chatId: number;
    userText: string;
    assistantText: string;
    toolTranscripts: string[];
    memoryTurns: number;
  }): Promise<void>;
  factoryReset(params: { chatId: number }): Promise<void>;
}

export function createMemoryGateway(deps: RuntimeDeps): MemoryGateway {
  let runtime: ReturnType<typeof createMemoryRuntime> | undefined;

  const getRuntime = () => {
    if (!runtime) {
      runtime = createMemoryRuntime(memoryDepsFromRuntime(deps));
    }
    return runtime;
  };

  return {
    getConfigSafe() {
      try {
        return getRuntime().getConfig();
      } catch (error) {
        throw new Error(`Memory config error: ${compactErrorMessage(error)}`);
      }
    },
    renderContext(params) {
      return getRuntime().renderContext(params);
    },
    find(params) {
      return getRuntime().find(params);
    },
    save(params) {
      return getRuntime().save(params);
    },
    remove(params) {
      return getRuntime().remove(params);
    },
    persistTurn(params) {
      return getRuntime().persistTurn(params);
    },
    factoryReset(params) {
      return getRuntime().factoryReset(params);
    },
  };
}

function memoryDepsFromRuntime(deps: RuntimeDeps) {
  return {
    db: deps.DRECLAW_DB,
    aiBinding: deps.AI,
    vectorIndex: deps.VECTORIZE_MEMORY,
    settings: {
      enabled: deps.MEMORY_ENABLED,
      retentionDays: deps.MEMORY_RETENTION_DAYS,
      maxInjectTokens: deps.MEMORY_MAX_INJECT_TOKENS,
      reflectionEveryTurns: deps.MEMORY_REFLECTION_EVERY_TURNS,
      embeddingModel: deps.MEMORY_EMBEDDING_MODEL,
    },
  };
}
