import type { MemoryDeps } from "./types";
import { getMemoryConfig, type MemoryConfig } from "./config";
import { executeMemoryFind, executeMemoryRemove, executeMemorySave } from "./execute-api";
import { buildMemoryId } from "./ids";
import {
  attachMemoryFactSource,
  deleteMemoryForChat,
  deleteOldMemoryEpisodes,
  insertMemoryEpisode,
  listActiveMemoryFacts,
  upsertSimilarMemoryFact,
} from "./repo";
import { runMemoryReflection } from "./reflection";
import { retrieveMemoryContext } from "./retrieve";
import { extractFacts, scoreSalience } from "./salience";
import { deleteFactVectors, upsertFactVector } from "./vectorize";
import { embedText } from "./embeddings";

type PersistTurnParams = {
  chatId: number;
  userText: string;
  assistantText: string;
  toolTranscripts: string[];
  memoryTurns: number;
};

type RenderContextParams = {
  chatId: number;
  query: string;
  factTopK: number;
  episodeTopK: number;
};

export function createMemoryRuntime(deps: MemoryDeps): MemoryRuntime {
  return new MemoryRuntime(normalizeMemoryDeps(deps));
}

export class MemoryRuntime {
  constructor(private readonly deps: MemoryDeps) {}

  getConfig(): MemoryConfig {
    return getMemoryConfig(this.deps);
  }

  async find(params: { chatId: number; payload: unknown }): Promise<unknown> {
    const config = this.requireEnabled();
    return executeMemoryFind({
      deps: this.deps,
      db: this.deps.db,
      chatId: params.chatId,
      embeddingModel: config.embeddingModel,
      payload: params.payload,
    });
  }

  async save(params: { chatId: number; payload: unknown }): Promise<unknown> {
    const config = this.requireEnabled();
    return executeMemorySave({
      deps: this.deps,
      db: this.deps.db,
      chatId: params.chatId,
      embeddingModel: config.embeddingModel,
      payload: params.payload,
    });
  }

  async remove(params: { chatId: number; payload: unknown }): Promise<unknown> {
    this.requireEnabled();
    return executeMemoryRemove({
      deps: this.deps,
      db: this.deps.db,
      chatId: params.chatId,
      payload: params.payload,
    });
  }

  async renderContext(params: RenderContextParams): Promise<string> {
    const config = this.getConfig();
    if (!config.enabled) return "";
    const retrieved = await retrieveMemoryContext({
      deps: this.deps,
      db: this.deps.db,
      chatId: params.chatId,
      query: params.query,
      embeddingModel: config.embeddingModel,
      factTopK: params.factTopK,
      episodeTopK: params.episodeTopK,
    });
    if (!retrieved.facts.length && !retrieved.episodes.length) return "";

    const lines: string[] = [];
    if (retrieved.facts.length) {
      lines.push("Facts:");
      for (const fact of retrieved.facts) lines.push(`- [${fact.kind}] ${fact.text}`);
    }
    if (retrieved.episodes.length) {
      lines.push("Recent episodes:");
      for (const episode of retrieved.episodes) {
        lines.push(`- ${episode.role}: ${truncateForLog(episode.content, 220)}`);
      }
    }
    const joined = lines.join("\n");
    const maxChars = config.maxInjectTokens * 4;
    return joined.length <= maxChars ? joined : `${joined.slice(0, Math.max(0, maxChars - 1))}...`;
  }

  async persistTurn(params: PersistTurnParams): Promise<void> {
    const config = this.getConfig();
    if (!config.enabled) return;
    const nowIso = new Date().toISOString();
    const episodeInputs: Array<{ role: "user" | "assistant" | "tool"; content: string }> = [
      { role: "user", content: params.userText },
      ...params.toolTranscripts.map((content) => ({ role: "tool" as const, content })),
      { role: "assistant", content: params.assistantText },
    ];

    for (const entry of episodeInputs) {
      const salience = scoreSalience(entry.content);
      if (!salience.shouldStoreEpisode) continue;
      const episodeId = buildMemoryId("episode");
      await insertMemoryEpisode(this.deps.db, {
        id: episodeId,
        chatId: params.chatId,
        role: entry.role,
        content: entry.content,
        salience: salience.score,
        createdAt: nowIso,
      });
      if (!salience.shouldStoreFact) continue;
      const facts = extractFacts(entry.content);
      for (const extracted of facts) {
        const saved = await upsertSimilarMemoryFact(this.deps.db, {
          id: buildMemoryId("fact"),
          chatId: params.chatId,
          kind: extracted.kind,
          text: extracted.text,
          confidence: extracted.confidence,
          nowIso,
        });
        await attachMemoryFactSource(this.deps.db, saved.fact.id, episodeId, nowIso);
        if (saved.created) {
          const vector = await embedText(
            this.deps.aiBinding ?? (this.deps as unknown as Ai),
            config.embeddingModel,
            saved.fact.text,
          );
          await upsertFactVector(
            this.deps.vectorIndex ?? (this.deps as unknown as VectorizeIndex),
            saved.fact.id,
            params.chatId,
            vector,
          );
        }
      }
    }

    if ((params.memoryTurns + 1) % config.reflectionEveryTurns === 0) {
      const reflection = await runMemoryReflection({
        db: this.deps.db,
        chatId: params.chatId,
        limit: 24,
        nowIso,
      });
      if (reflection.writtenFacts > 0) {
        const facts = await listActiveMemoryFacts(this.deps.db, params.chatId, 200);
        for (const fact of facts) {
          const vector = await embedText(
            this.deps.aiBinding ?? (this.deps as unknown as Ai),
            config.embeddingModel,
            fact.text,
          );
          await upsertFactVector(
            this.deps.vectorIndex ?? (this.deps as unknown as VectorizeIndex),
            fact.id,
            params.chatId,
            vector,
          );
        }
      }
    }

    await deleteOldMemoryEpisodes(
      this.deps.db,
      params.chatId,
      new Date(Date.now() - config.retentionDays * 24 * 60 * 60 * 1000).toISOString(),
    );
  }

  async factoryReset(params: { chatId: number }): Promise<void> {
    const config = this.getConfig();
    if (!config.enabled) return;
    const existingFacts = await listActiveMemoryFacts(this.deps.db, params.chatId, 500);
    await deleteMemoryForChat(this.deps.db, params.chatId);
    await deleteFactVectors(
      this.deps.vectorIndex ?? (this.deps as unknown as VectorizeIndex),
      existingFacts.map((item) => item.id),
    );
  }

  private requireEnabled(): MemoryConfig {
    const config = this.getConfig();
    if (!config.enabled) throw new Error("Memory is disabled");
    return config;
  }
}

function normalizeMemoryDeps(input: MemoryDeps | Record<string, unknown>): MemoryDeps {
  if ((input as MemoryDeps).settings) return input as MemoryDeps;
  const env = input as Record<string, unknown>;
  return {
    db: env.DRECLAW_DB as D1Database,
    aiBinding: env.AI as Ai | undefined,
    vectorIndex: env.VECTORIZE_MEMORY as VectorizeIndex | undefined,
    settings: {
      enabled: env.MEMORY_ENABLED as string | undefined,
      retentionDays: env.MEMORY_RETENTION_DAYS as string | undefined,
      maxInjectTokens: env.MEMORY_MAX_INJECT_TOKENS as string | undefined,
      reflectionEveryTurns: env.MEMORY_REFLECTION_EVERY_TURNS as string | undefined,
      embeddingModel: env.MEMORY_EMBEDDING_MODEL as string | undefined,
    },
  };
}

function truncateForLog(value: string, max: number): string {
  const input = String(value ?? "").trim();
  return input.length <= max ? input : `${input.slice(0, Math.max(0, max - 3))}...`;
}
