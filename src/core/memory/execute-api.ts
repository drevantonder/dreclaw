import {
  deleteMemoryFactById,
  getActiveMemoryFactByTarget,
  listActiveMemoryFacts,
  upsertSimilarMemoryFact,
  type MemoryFactRecord,
} from "./repo";
import type { Env } from "../../types";
import { embedText } from "./embeddings";
import { buildMemoryId } from "./ids";
import { retrieveMemoryContext } from "./retrieve";
import { upsertFactVector, deleteFactVectors } from "./vectorize";

type MemoryKind = "preference" | "fact" | "goal" | "identity";

export async function executeMemoryFind(params: {
  env: Env;
  db: D1Database;
  chatId: number;
  embeddingModel: string;
  payload: unknown;
}): Promise<{
  query: string;
  count: number;
  truncated: boolean;
  facts: Array<{ id: string; kind: MemoryKind; text: string; confidence: number }>;
}> {
  const parsed = parseFindPayload(params.payload);

  if (!parsed.query) {
    const facts = await listActiveMemoryFacts(params.db, params.chatId, parsed.topK);
    return {
      query: parsed.query,
      count: facts.length,
      truncated: false,
      facts: facts.map(serializeFact),
    };
  }

  const result = await retrieveMemoryContext({
    env: params.env,
    db: params.db,
    chatId: params.chatId,
    query: parsed.query,
    embeddingModel: params.embeddingModel,
    factTopK: parsed.topK,
    episodeTopK: 0,
  });

  let facts = result.facts;
  if (!facts.length && isShortQuery(parsed.query)) {
    const normalized = normalizeForSearch(parsed.query);
    const lexical = await listActiveMemoryFacts(params.db, params.chatId, 200);
    facts = lexical
      .filter((fact) => normalizeForSearch(fact.text).includes(normalized))
      .slice(0, parsed.topK);
  }

  return {
    query: parsed.query,
    count: facts.length,
    truncated: facts.length >= parsed.topK,
    facts: facts.map(serializeFact),
  };
}

export async function executeMemorySave(params: {
  env: Env;
  db: D1Database;
  chatId: number;
  embeddingModel: string;
  payload: unknown;
}): Promise<{ id: string; created: boolean; kind: MemoryKind; text: string; confidence: number }> {
  const parsed = parseSavePayload(params.payload);
  const nowIso = new Date().toISOString();
  const saved = await upsertSimilarMemoryFact(params.db, {
    id: buildMemoryId("fact"),
    chatId: params.chatId,
    kind: parsed.kind,
    text: parsed.text,
    confidence: parsed.confidence,
    nowIso,
  });
  const vector = await embedText(params.env, params.embeddingModel, saved.fact.text);
  await upsertFactVector(params.env, saved.fact.id, params.chatId, vector);
  return {
    id: saved.fact.id,
    created: saved.created,
    kind: saved.fact.kind,
    text: saved.fact.text,
    confidence: saved.fact.confidence,
  };
}

export async function executeMemoryRemove(params: {
  env: Env;
  db: D1Database;
  chatId: number;
  payload: unknown;
}): Promise<{ ok: boolean; removedId?: string; message: string }> {
  const target = parseRemovePayload(params.payload);
  const fact = await getActiveMemoryFactByTarget(params.db, params.chatId, target);
  if (!fact) {
    return { ok: false, message: "Memory target not found" };
  }
  const removed = await deleteMemoryFactById(params.db, params.chatId, fact.id);
  if (!removed) {
    return { ok: false, message: "Memory target could not be removed" };
  }
  await deleteFactVectors(params.env, [fact.id]);
  return { ok: true, removedId: fact.id, message: "Memory removed" };
}

function parseFindPayload(input: unknown): { query: string; topK: number } {
  if (!input || typeof input !== "object") {
    throw new Error("memory.find requires payload object");
  }
  const payload = input as { query?: unknown; topK?: unknown };
  assertSupportedKeys(payload, ["query", "topK"], "memory.find");
  const query = toStringInput(payload.query).trim();
  if (query.length > 600) throw new Error("memory.find query too long");
  const topKRaw = payload.topK;
  const topK =
    typeof topKRaw === "number" && Number.isFinite(topKRaw)
      ? Math.max(1, Math.min(20, Math.trunc(topKRaw)))
      : 6;
  return { query, topK };
}

function parseSavePayload(input: unknown): { text: string; kind: MemoryKind; confidence: number } {
  if (!input || typeof input !== "object") {
    throw new Error("memory.save requires payload object");
  }
  const payload = input as { text?: unknown; kind?: unknown; confidence?: unknown };
  assertSupportedKeys(payload, ["text", "kind", "confidence"], "memory.save");
  const text = toStringInput(payload.text).trim();
  if (!text) throw new Error("memory.save requires non-empty text");
  if (text.length > 2000) throw new Error("memory.save text too long");

  const kindRaw = toStringInput(payload.kind, "fact").trim().toLowerCase();
  const kind: MemoryKind =
    kindRaw === "preference" || kindRaw === "goal" || kindRaw === "identity" || kindRaw === "fact"
      ? kindRaw
      : "fact";

  const confidenceRaw = payload.confidence;
  const confidence =
    typeof confidenceRaw === "number" && Number.isFinite(confidenceRaw)
      ? Math.max(0, Math.min(1, confidenceRaw))
      : 0.85;
  return { text, kind, confidence };
}

function parseRemovePayload(input: unknown): string {
  if (!input || typeof input !== "object") {
    throw new Error("memory.remove requires payload object");
  }
  const payload = input as { target?: unknown };
  assertSupportedKeys(payload, ["target"], "memory.remove");
  const target = toStringInput(payload.target).trim();
  if (!target) throw new Error("memory.remove requires target");
  if (target.length > 2000) throw new Error("memory.remove target too long");
  return target;
}

function toStringInput(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return fallback;
}

function serializeFact(fact: MemoryFactRecord): {
  id: string;
  kind: MemoryKind;
  text: string;
  confidence: number;
} {
  return {
    id: fact.id,
    kind: fact.kind,
    text: fact.text,
    confidence: fact.confidence,
  };
}

function isShortQuery(input: string): boolean {
  return normalizeForSearch(input).length <= 6;
}

function normalizeForSearch(input: string): string {
  return String(input ?? "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function assertSupportedKeys(
  payload: Record<string, unknown>,
  allowed: string[],
  method: string,
): void {
  const invalid = Object.keys(payload).filter((key) => !allowed.includes(key));
  if (!invalid.length) return;
  throw new Error(`${method} unsupported args: ${invalid.join(", ")}`);
}
