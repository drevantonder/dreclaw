#!/usr/bin/env node
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { generateText, stepCountIs, tool } from "ai";
import { z } from "zod";

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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.apiKey.trim()) fail("Missing API key. Pass --api-key or set OPENCODE_ZEN_API_KEY");

  const provider = createOpenAICompatible({
    name: "opencode",
    apiKey: args.apiKey.trim(),
    baseURL: args.baseUrl.trim(),
  });
  const model = provider(args.model);

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

  const tools = {
    custom_context_get: tool({
      description: "Get current custom context and version",
      inputSchema: z.object({}),
      execute: async () => ({ version, custom_context: customContext }),
    }),
    custom_context_set: tool({
      description: "Create or update one custom context entry by id",
      inputSchema: z.object({ id: z.string(), text: z.string(), expected_version: z.number().optional() }),
      execute: async ({ id, text, expected_version }) => {
        if (typeof expected_version === "number" && expected_version !== version) {
          return { ok: false, error: `Version conflict: expected ${expected_version}, current ${version}` };
        }
        const normalizedId = id.trim().toLowerCase();
        if (!normalizedId) return { ok: false, error: "id is required" };
        if (!text.trim()) return { ok: false, error: "text is required" };
        const existingIndex = customContext.findIndex((item) => item.id === normalizedId);
        if (existingIndex >= 0) customContext[existingIndex] = { id: normalizedId, text: text.trim() };
        else customContext.push({ id: normalizedId, text: text.trim() });
        version += 1;
        return { ok: true, version };
      },
    }),
    custom_context_delete: tool({
      description: "Delete one custom context entry by id",
      inputSchema: z.object({ id: z.string(), expected_version: z.number().optional() }),
      execute: async ({ id, expected_version }) => {
        if (typeof expected_version === "number" && expected_version !== version) {
          return { ok: false, error: `Version conflict: expected ${expected_version}, current ${version}` };
        }
        const normalizedId = id.trim().toLowerCase();
        const existingIndex = customContext.findIndex((item) => item.id === normalizedId);
        if (!normalizedId || existingIndex < 0) {
          return { ok: false, error: `custom_context entry not found: ${normalizedId || "(empty)"}` };
        }
        customContext.splice(existingIndex, 1);
        version += 1;
        return { ok: true, version };
      },
    }),
  };

  const messages = [{ role: "user", content: args.prompt }];

  for (let turn = 0; turn < args.maxTurns; turn += 1) {
    const result = await generateText({
      model,
      system: `${SYSTEM_PROMPT}\n\nCustom context:\n${renderCustomContextXml()}`,
      messages,
      tools,
      stopWhen: stepCountIs(1),
    });
    messages.push(...result.response.messages.slice(1));
    const text = result.text.trim();
    if (text) {
      process.stdout.write(`Smoke OK\nModel: ${args.model}\nResponse:\n${text}\n`);
      return;
    }
  }

  fail(`Smoke test exceeded max turns (${args.maxTurns})`);
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : "Unexpected smoke failure");
});
