#!/usr/bin/env node
import { Type, complete, getModel } from "@mariozechner/pi-ai";

const SYSTEM_PROMPT = "You are dréclaw. Be concise.";

const DEFAULT_CUSTOM_CONTEXT = [
  {
    id: "identity",
    text: "I am friendly, direct, and practical.",
  },
];

function parseArgs(argv) {
  const args = {
    prompt: "Reply with one short sentence proving smoke test works.",
    model: "kimi-k2.5-free",
    maxTurns: 6,
    baseUrl: "https://opencode.ai/zen/v1",
    apiKey: process.env.OPENCODE_ZEN_API_KEY ?? "",
  };

  for (let i = 0; i < argv.length; i += 1) {
    const part = argv[i];
    if (part === "--prompt") args.prompt = argv[++i] ?? args.prompt;
    else if (part === "--model") args.model = argv[++i] ?? args.model;
    else if (part === "--max-turns") args.maxTurns = Number(argv[++i] ?? args.maxTurns);
    else if (part === "--base-url") args.baseUrl = argv[++i] ?? args.baseUrl;
    else if (part === "--api-key") args.apiKey = argv[++i] ?? args.apiKey;
    else if (part === "--help" || part === "-h") {
      process.stdout.write(
        "Usage: pnpm smoke:live -- --prompt \"hey\" [--model kimi-k2.5-free] [--base-url https://opencode.ai/zen/v1] [--api-key <zen-key>]\n",
      );
      process.exit(0);
    }
  }

  if (!Number.isFinite(args.maxTurns) || args.maxTurns <= 0) args.maxTurns = 6;
  return args;
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function parseToolArgs(value) {
  if (!value || typeof value !== "object") return {};
  return value;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.apiKey.trim()) fail("Missing API key. Pass --api-key or set OPENCODE_ZEN_API_KEY");

  let model;
  try {
    model = getModel("opencode", args.model);
  } catch {
    model = undefined;
  }
  if (!model) {
    model = {
      id: args.model,
      name: args.model,
      api: "openai-completions",
      provider: "opencode",
      baseUrl: args.baseUrl.trim(),
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 262144,
      maxTokens: 32768,
    };
  }
  model.baseUrl = args.baseUrl.trim();

  let version = 1;
  let customContext = JSON.parse(JSON.stringify(DEFAULT_CUSTOM_CONTEXT));

  const renderCustomContextXml = () => {
    const entries = [...customContext].sort((a, b) => a.id.localeCompare(b.id));
    const body = entries
      .map((item) => {
        const text = String(item.text ?? "");
        return `<custom_context id="${item.id}">\n${text}\n</custom_context>`;
      })
      .join("\n");
    return `<custom_context_manifest version="${version}" count="${entries.length}">\n${body}\n</custom_context_manifest>`;
  };

  const tools = [
    {
      name: "custom_context_get",
      description: "Get current custom context and version",
      parameters: Type.Object({}),
    },
    {
      name: "custom_context_set",
      description: "Create or update one custom context entry by id",
      parameters: Type.Object({
        id: Type.String(),
        text: Type.String(),
        expected_version: Type.Optional(Type.Number()),
      }),
    },
    {
      name: "custom_context_delete",
      description: "Delete one custom context entry by id",
      parameters: Type.Object({
        id: Type.String(),
        expected_version: Type.Optional(Type.Number()),
      }),
    },
  ];

  const context = {
    systemPrompt: `${SYSTEM_PROMPT}\n\nCustom context:\n${renderCustomContextXml()}`,
    tools,
    messages: [
      { role: "user", content: args.prompt, timestamp: Date.now() },
    ],
  };

  for (let turn = 0; turn < args.maxTurns; turn += 1) {
    const assistant = await complete(model, context, {
      apiKey: args.apiKey,
      transport: "sse",
      maxRetryDelayMs: 20_000,
    });

    if (assistant.stopReason === "error" || assistant.stopReason === "aborted") {
      fail(assistant.errorMessage || `Model failed with stop reason: ${assistant.stopReason}`);
    }

    context.messages.push(assistant);
    const toolCalls = assistant.content.filter((block) => block.type === "toolCall");
    if (!toolCalls.length) {
      const text = assistant.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n")
        .trim();
      if (!text) fail("Smoke test returned empty final response");
      process.stdout.write(`Smoke OK\nModel: ${args.model}\nResponse:\n${text}\n`);
      return;
    }

    for (const call of toolCalls) {
      const argsObj = parseToolArgs(call.arguments);
      if (call.name === "custom_context_get") {
        context.messages.push({
          role: "toolResult",
          toolCallId: call.id,
          toolName: call.name,
          content: [{ type: "text", text: JSON.stringify({ version, custom_context: customContext }, null, 2) }],
          isError: false,
          timestamp: Date.now(),
        });
        continue;
      }

      if (call.name === "custom_context_set") {
        const expectedVersion = argsObj.expected_version;
        if (typeof expectedVersion === "number" && expectedVersion !== version) {
          context.messages.push({
            role: "toolResult",
            toolCallId: call.id,
            toolName: call.name,
            content: [{ type: "text", text: `Version conflict: expected ${expectedVersion}, current ${version}` }],
            isError: true,
            timestamp: Date.now(),
          });
          continue;
        }

        const id = typeof argsObj.id === "string" ? argsObj.id.trim().toLowerCase() : "";
        if (!id) {
          context.messages.push({
            role: "toolResult",
            toolCallId: call.id,
            toolName: call.name,
            content: [{ type: "text", text: "id is required" }],
            isError: true,
            timestamp: Date.now(),
          });
          continue;
        }

        if (typeof argsObj.text !== "string" || !argsObj.text.trim()) {
          context.messages.push({
            role: "toolResult",
            toolCallId: call.id,
            toolName: call.name,
            content: [{ type: "text", text: "text is required" }],
            isError: true,
            timestamp: Date.now(),
          });
          continue;
        }

        const next = String(argsObj.text).trim();
        const existingIndex = customContext.findIndex((item) => item.id === id);
        if (existingIndex >= 0) customContext[existingIndex] = { id, text: next };
        else customContext.push({ id, text: next });

        version += 1;
        context.systemPrompt = `${SYSTEM_PROMPT}\n\nCustom context:\n${renderCustomContextXml()}`;
        context.messages.push({
          role: "toolResult",
          toolCallId: call.id,
          toolName: call.name,
          content: [{ type: "text", text: JSON.stringify({ version }, null, 2) }],
          isError: false,
          timestamp: Date.now(),
        });
        continue;
      }

      if (call.name === "custom_context_delete") {
        const expectedVersion = argsObj.expected_version;
        if (typeof expectedVersion === "number" && expectedVersion !== version) {
          context.messages.push({
            role: "toolResult",
            toolCallId: call.id,
            toolName: call.name,
            content: [{ type: "text", text: `Version conflict: expected ${expectedVersion}, current ${version}` }],
            isError: true,
            timestamp: Date.now(),
          });
          continue;
        }

        const id = typeof argsObj.id === "string" ? argsObj.id.trim().toLowerCase() : "";
        const existingIndex = customContext.findIndex((item) => item.id === id);
        if (!id || existingIndex < 0) {
          context.messages.push({
            role: "toolResult",
            toolCallId: call.id,
            toolName: call.name,
            content: [{ type: "text", text: `custom_context entry not found: ${id || "(empty)"}` }],
            isError: true,
            timestamp: Date.now(),
          });
          continue;
        }

        customContext.splice(existingIndex, 1);

        version += 1;
        context.systemPrompt = `${SYSTEM_PROMPT}\n\nCustom context:\n${renderCustomContextXml()}`;
        context.messages.push({
          role: "toolResult",
          toolCallId: call.id,
          toolName: call.name,
          content: [{ type: "text", text: JSON.stringify({ version }, null, 2) }],
          isError: false,
          timestamp: Date.now(),
        });
        continue;
      }

      context.messages.push({
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: "text", text: `Unsupported tool: ${call.name}` }],
        isError: true,
        timestamp: Date.now(),
      });
    }
  }

  fail(`Smoke test exceeded max turns (${args.maxTurns})`);
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : "Unexpected smoke failure");
});
