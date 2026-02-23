#!/usr/bin/env node
import { Bash } from "just-bash";
import { Type, complete, getModel } from "@mariozechner/pi-ai";

const WORKSPACE_ROOT = "/workspace";
const SYSTEM_PROMPT =
  "You are dreclaw strict v0. Use tools only when needed. Return concise final answers. Do not echo user text. Use bash/read/write/edit only through tool calls.";

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

function normalizePath(input) {
  const trimmed = String(input ?? "").trim();
  if (!trimmed) return WORKSPACE_ROOT;
  const absolute = trimmed.startsWith("/") ? trimmed : `${WORKSPACE_ROOT}/${trimmed}`;
  const normalized = absolute.replace(/\/{2,}/g, "/");
  if (normalized === WORKSPACE_ROOT || normalized.startsWith(`${WORKSPACE_ROOT}/`)) return normalized;
  throw new Error(`Path escapes workspace root: ${trimmed}`);
}

function shellEnv() {
  return {
    HOME: WORKSPACE_ROOT,
    XDG_CONFIG_HOME: `${WORKSPACE_ROOT}/.config`,
    XDG_CACHE_HOME: `${WORKSPACE_ROOT}/.cache`,
    PATH: "/usr/local/bin:/usr/bin:/bin",
  };
}

async function runToolCall(toolCall, bash) {
  try {
    if (toolCall.name === "read") {
      const path = normalizePath(toolCall.arguments.path);
      const output = await bash.fs.readFile(path, "utf8");
      return { ok: true, output };
    }

    if (toolCall.name === "write") {
      const path = normalizePath(toolCall.arguments.path);
      const content = String(toolCall.arguments.content ?? "");
      await bash.writeFile(path, content);
      return { ok: true, output: `Wrote ${path}` };
    }

    if (toolCall.name === "edit") {
      const path = normalizePath(toolCall.arguments.path);
      const find = String(toolCall.arguments.find ?? "");
      const replace = String(toolCall.arguments.replace ?? "");
      const current = await bash.fs.readFile(path, "utf8");
      if (!current.includes(find)) return { ok: false, output: "", error: `Text not found in ${path}` };
      await bash.writeFile(path, current.replace(find, replace));
      return { ok: true, output: `Edited ${path}` };
    }

    if (toolCall.name === "bash") {
      const command = String(toolCall.arguments.command ?? "");
      const result = await bash.exec(command, { cwd: WORKSPACE_ROOT, env: shellEnv() });
      const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
      return { ok: result.exitCode === 0, output, error: result.exitCode === 0 ? undefined : `Exit code ${result.exitCode}` };
    }

    return { ok: false, output: "", error: `Unsupported tool: ${toolCall.name}` };
  } catch (error) {
    return {
      ok: false,
      output: "",
      error: error instanceof Error ? error.message : "Unknown tool error",
    };
  }
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
  const tools = [
    {
      name: "read",
      description: "Read file content from active workspace",
      parameters: Type.Object({ path: Type.String() }),
    },
    {
      name: "write",
      description: "Write file content to active workspace",
      parameters: Type.Object({ path: Type.String(), content: Type.String() }),
    },
    {
      name: "edit",
      description: "Replace text within a file",
      parameters: Type.Object({ path: Type.String(), find: Type.String(), replace: Type.String() }),
    },
    {
      name: "bash",
      description: "Run shell command in /workspace",
      parameters: Type.Object({ command: Type.String() }),
    },
  ];

  const context = {
    systemPrompt: SYSTEM_PROMPT,
    tools,
    messages: [{ role: "user", content: args.prompt, timestamp: Date.now() }],
  };

  const bash = new Bash({ cwd: WORKSPACE_ROOT, files: {}, env: shellEnv() });
  await bash.exec("mkdir -p /workspace/.config /workspace/.cache", { cwd: WORKSPACE_ROOT, env: shellEnv() });

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
      const text = assistant.content.filter((block) => block.type === "text").map((block) => block.text).join("\n").trim();
      if (!text) fail("Smoke test returned empty final response");
      process.stdout.write(`Smoke OK\nModel: ${args.model}\nResponse:\n${text}\n`);
      return;
    }

    for (const call of toolCalls) {
      const result = await runToolCall(call, bash);
      context.messages.push({
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        content: [{ type: "text", text: result.ok ? result.output : `error=${result.error || "tool failed"}\noutput=${result.output}` }],
        isError: !result.ok,
        timestamp: Date.now(),
      });
    }
  }

  fail(`Smoke test exceeded max turns (${args.maxTurns})`);
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : "Unexpected smoke failure");
});
