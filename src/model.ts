import { runWithRetry } from "./db";

export interface ModelMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;
  tool_call_id?: string;
}

export interface ModelToolCall {
  id: string;
  name: "read" | "write" | "edit" | "bash";
  args: Record<string, unknown>;
}

export interface ModelCompletion {
  text: string;
  toolCalls: ModelToolCall[];
}

export function getModel(provider: string, model: string) {
  return {
    complete: (params: {
      apiKey: string;
      apiBaseUrl?: string;
      messages: ModelMessage[];
      tools?: Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
    }) => complete(provider, model, params),
  };
}

async function complete(
  provider: string,
  model: string,
  params: {
    apiKey: string;
    apiBaseUrl?: string;
    messages: ModelMessage[];
    tools?: Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
  },
): Promise<ModelCompletion> {
  if (provider !== "openai-codex") {
    throw new Error(`Unsupported model provider: ${provider}`);
  }

  const endpoint = `${(params.apiBaseUrl || "https://api.openai.com").replace(/\/+$/, "")}/v1/chat/completions`;
  const body = {
    model,
    messages: params.messages,
    temperature: 0,
    tools: (params.tools ?? []).map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    })),
    tool_choice: "auto",
  };

  return runWithRetry(async () => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${params.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    });

    const payload = (await response.json()) as {
      choices?: Array<{
        message?: {
          content?: string;
          tool_calls?: Array<{
            id?: string;
            function?: { name?: string; arguments?: string };
          }>;
        };
      }>;
      error?: { message?: string };
    };

    if (!response.ok) {
      throw new Error(payload.error?.message || `Model call failed with status ${response.status}`);
    }

    const message = payload.choices?.[0]?.message;
    const text = message?.content ?? "";
    const toolCalls = (message?.tool_calls ?? [])
      .map((call): ModelToolCall | null => {
        const name = String(call.function?.name ?? "");
        if (name !== "read" && name !== "write" && name !== "edit" && name !== "bash") return null;
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(call.function?.arguments || "{}") as Record<string, unknown>;
        } catch {
          args = {};
        }
        return {
          id: call.id || crypto.randomUUID(),
          name,
          args,
        };
      })
      .filter((value): value is ModelToolCall => Boolean(value));

    return { text, toolCalls };
  });
}
