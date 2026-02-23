import { complete as piComplete, getModel as piGetModel, type Context, type Message } from "@mariozechner/pi-ai";
import { runWithRetry } from "./db";
import { isToolName, type ToolName } from "./tool-schema";

export interface ModelMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;
  tool_call_id?: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: {
      name: ToolName;
      arguments: string;
    };
  }>;
}

export interface ModelToolCall {
  id: string;
  name: ToolName;
  args: Record<string, unknown>;
  rawArguments: string;
}

export interface ModelCompletion {
  text: string;
  toolCalls: ModelToolCall[];
}

export function getModel(model: string) {
  return {
    complete: (params: {
      apiKey: string;
      messages: ModelMessage[];
      tools?: Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
      baseUrl?: string;
      headers?: Record<string, string>;
      transport?: "sse" | "websocket" | "auto";
    }) => complete(model, params),
  };
}

async function complete(
  model: string,
  params: {
    apiKey: string;
    messages: ModelMessage[];
    tools?: Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
    baseUrl?: string;
    headers?: Record<string, string>;
    transport?: "sse" | "websocket" | "auto";
  },
): Promise<ModelCompletion> {
  const baseModel = resolveModel(model);
  const baseHeaders = (baseModel as { headers?: Record<string, string> }).headers ?? {};
  const piModel = {
    ...baseModel,
    baseUrl: params.baseUrl?.trim() || baseModel.baseUrl,
    headers: {
      ...baseHeaders,
      ...(params.headers ?? {}),
    },
  };
  const context = toContext(params.messages, params.tools ?? []);

  return runWithRetry(async () => {
    const assistant = await piComplete(piModel as never, context, {
      apiKey: params.apiKey,
      transport: params.transport ?? "sse",
    });

    if (assistant.stopReason === "error" || assistant.stopReason === "aborted") {
      throw new Error(assistant.errorMessage || "Model call failed");
    }

    const text = assistant.content
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();

    const toolCalls = assistant.content
      .filter((block): block is { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> } =>
        block.type === "toolCall",
      )
      .map((block): ModelToolCall | null => {
        if (!isToolName(block.name)) return null;

        return {
          id: block.id,
          name: block.name,
          args: block.arguments ?? {},
          rawArguments: JSON.stringify(block.arguments ?? {}),
        };
      })
      .filter((value): value is ModelToolCall => Boolean(value));

    return { text, toolCalls };
  });
}

function resolveModel(model: string) {
  try {
    const builtIn = piGetModel("opencode", model as "kimi-k2.5");
    if (builtIn) return builtIn;
  } catch {
    // Fall through to dynamic model descriptor.
  }

  return {
    id: model,
    name: model,
    api: "openai-completions",
    provider: "opencode",
    baseUrl: "https://opencode.ai/zen/v1",
    reasoning: true,
    input: ["text"] as Array<"text" | "image">,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 262144,
    maxTokens: 32768,
  };
}

function toContext(
  messages: ModelMessage[],
  tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>,
): Context {
  const contextMessages: Message[] = [];
  let systemPrompt = "";

  for (const message of messages) {
    if (message.role === "system") {
      systemPrompt = typeof message.content === "string" ? message.content : "";
      continue;
    }

    if (message.role === "user") {
      contextMessages.push({
        role: "user",
        content: toUserContent(message.content),
        timestamp: Date.now(),
      });
      continue;
    }

    if (message.role === "assistant") {
      const content: Array<{ type: "text"; text: string } | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> }> =
        [];

      if (typeof message.content === "string" && message.content.trim()) {
        content.push({ type: "text", text: message.content });
      }

      for (const call of message.tool_calls ?? []) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
        } catch {
          args = {};
        }

        content.push({
          type: "toolCall",
          id: call.id,
          name: call.function.name,
          arguments: args,
        });
      }

      if (content.length) {
        contextMessages.push({
          role: "assistant",
          content,
          api: "openai-completions",
          provider: "opencode",
          model: "unknown",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "toolUse",
          timestamp: Date.now(),
        });
      }
      continue;
    }

    if (message.role === "tool") {
      contextMessages.push({
        role: "toolResult",
        toolCallId: message.tool_call_id || "unknown-tool-call",
        toolName: "tool",
        content: [{ type: "text", text: String(message.content ?? "") }],
        isError: false,
        timestamp: Date.now(),
      });
    }
  }

  return {
    systemPrompt,
    messages: contextMessages,
    tools: tools as Context["tools"],
  };
}

function toUserContent(
  content: string | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>,
): string | Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> {
  if (typeof content === "string") return content;

  const result: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }> = [];
  for (const block of content) {
    if (block.type === "text") {
      result.push({ type: "text", text: block.text });
      continue;
    }

    const parsed = parseDataUrl(block.image_url.url);
    if (parsed) {
      result.push({ type: "image", data: parsed.data, mimeType: parsed.mimeType });
    }
  }
  return result;
}

function parseDataUrl(url: string): { mimeType: string; data: string } | null {
  const match = /^data:([^;]+);base64,(.+)$/i.exec(url.trim());
  if (!match) return null;
  return { mimeType: match[1], data: match[2] };
}
