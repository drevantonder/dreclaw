import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";

function usage() {
  return {
    inputTokens: {
      total: 12,
      noCache: 12,
      cacheRead: undefined,
      cacheWrite: undefined,
    },
    outputTokens: {
      total: 12,
      text: 12,
      reasoning: undefined,
    },
  };
}

export function createStreamingTextModel(params: {
  textSegments: string[];
  reasoningSegments?: string[];
  provider?: string;
  modelId?: string;
}) {
  const textSegments = params.textSegments.filter((segment) => segment.length > 0);
  const reasoningSegments = (params.reasoningSegments ?? []).filter(
    (segment) => segment.length > 0,
  );

  const chunks: Array<Record<string, unknown>> = [];

  if (reasoningSegments.length) {
    chunks.push({ type: "reasoning-start", id: "reasoning-1" });
    for (const segment of reasoningSegments) {
      chunks.push({ type: "reasoning-delta", id: "reasoning-1", delta: segment });
    }
    chunks.push({ type: "reasoning-end", id: "reasoning-1" });
  }

  chunks.push({ type: "text-start", id: "text-1" });
  for (const segment of textSegments) {
    chunks.push({ type: "text-delta", id: "text-1", delta: segment });
  }
  chunks.push({ type: "text-end", id: "text-1" });
  chunks.push({
    type: "finish",
    finishReason: { unified: "stop", raw: undefined },
    logprobs: undefined,
    usage: usage(),
  });

  return new MockLanguageModelV3({
    provider: params.provider ?? "mock-provider",
    modelId: params.modelId ?? "mock-model",
    doStream: (async () => ({
      stream: simulateReadableStream({
        chunks,
      }) as ReadableStream<any>,
    })) as any,
  });
}
