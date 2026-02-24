#!/usr/bin/env node
import { Type, complete, getModel } from "@mariozechner/pi-ai";

const SYSTEM_PROMPT = "You are dréclaw. Be concise.";

const DEFAULT_INJECTED_MESSAGES = [
  {
    id: "identity",
    message: {
      role: "system",
      content: [{ type: "text", text: "I am friendly, direct, and practical." }],
      timestamp: Date.now(),
    },
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
  let injectedMessages = JSON.parse(JSON.stringify(DEFAULT_INJECTED_MESSAGES));

  const tools = [
    {
      name: "injected_messages.get",
      description: "Get current injected messages and version",
      parameters: Type.Object({}),
    },
    {
      name: "injected_messages.set",
      description: "Create or update one injected message by id",
      parameters: Type.Object({
        id: Type.String(),
        message: Type.Any(),
        expected_version: Type.Optional(Type.Number()),
      }),
    },
    {
      name: "injected_messages.delete",
      description: "Delete one injected message by id",
      parameters: Type.Object({
        id: Type.String(),
        expected_version: Type.Optional(Type.Number()),
      }),
    },
  ];

  const context = {
    systemPrompt: SYSTEM_PROMPT,
    tools,
    messages: [
      {
        role: "assistant",
        content: [{ type: "text", text: `INJECTED_MESSAGES_START version=${version}` }],
        timestamp: Date.now(),
      },
      {
        role: "assistant",
        content: [{ type: "text", text: `INJECTED_MESSAGES_MANIFEST ids=${injectedMessages.map((item) => item.id).join(",")}` }],
        timestamp: Date.now(),
      },
      ...injectedMessages.map((item) => item.message),
      {
        role: "assistant",
        content: [{ type: "text", text: "INJECTED_MESSAGES_END" }],
        timestamp: Date.now(),
      },
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
      if (call.name === "injected_messages.get") {
        context.messages.push({
          role: "toolResult",
          toolCallId: call.id,
          toolName: call.name,
          content: [{ type: "text", text: JSON.stringify({ version, injected_messages: injectedMessages }, null, 2) }],
          isError: false,
          timestamp: Date.now(),
        });
        continue;
      }

      if (call.name === "injected_messages.set") {
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

        if (!argsObj.message || typeof argsObj.message !== "object") {
          context.messages.push({
            role: "toolResult",
            toolCallId: call.id,
            toolName: call.name,
            content: [{ type: "text", text: "message must be an object" }],
            isError: true,
            timestamp: Date.now(),
          });
          continue;
        }

        const next = JSON.parse(JSON.stringify(argsObj.message));
        const existingIndex = injectedMessages.findIndex((item) => item.id === id);
        if (existingIndex >= 0) injectedMessages[existingIndex] = { id, message: next };
        else injectedMessages.push({ id, message: next });

        version += 1;
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

      if (call.name === "injected_messages.delete") {
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
        const existingIndex = injectedMessages.findIndex((item) => item.id === id);
        if (!id || existingIndex < 0) {
          context.messages.push({
            role: "toolResult",
            toolCallId: call.id,
            toolName: call.name,
            content: [{ type: "text", text: `Injected message not found: ${id || "(empty)"}` }],
            isError: true,
            timestamp: Date.now(),
          });
          continue;
        }

        injectedMessages.splice(existingIndex, 1);

        version += 1;
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
