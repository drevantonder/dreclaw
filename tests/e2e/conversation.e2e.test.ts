import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/index";
import { createEnv } from "../helpers/fakes";

type MockContext = {
  systemPrompt: string;
  messages: Array<Record<string, unknown>>;
  tools: Array<{ name: string; execute: (toolCallId: string, params: unknown) => Promise<unknown> }>;
};

type MockAssistant = {
  stopReason: "endTurn" | "toolUse" | "error" | "aborted";
  content: Array<Record<string, unknown>>;
  errorMessage?: string;
};

const { modelCallContext, modelQueue } = vi.hoisted(() => {
  const callContext: MockContext[] = [];
  const queue: Array<MockAssistant | Error | ((context: MockContext) => MockAssistant | Error)> = [];
  return {
    modelCallContext: callContext,
    modelQueue: queue,
  };
});

vi.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: () => (_modelId: string) => ({ id: "mock-model" }),
}));

vi.mock("ai", () => {
  class MockToolLoopAgent {
    private readonly tools: Record<string, { execute?: (args: unknown) => Promise<unknown> }>;

    constructor(options?: { tools?: Record<string, { execute?: (args: unknown) => Promise<unknown> }> }) {
      this.tools = options?.tools ?? {};
    }

    private async run(options: {
      messages?: Array<Record<string, unknown>>;
      onStepFinish?: (event: { text: string; toolCalls: Array<Record<string, unknown>> }) => Promise<void> | void;
      experimental_onToolCallStart?: (event: {
        stepNumber: number;
        messages: Array<Record<string, unknown>>;
        toolCall: Record<string, unknown>;
      }) => Promise<void> | void;
    }) {
      const messages = [...(options.messages ?? [])];
      const fullStreamParts: Array<Record<string, unknown>> = [];

      while (true) {
        const systemPrompt =
          (messages.find((entry) => entry.role === "system")?.content as string | undefined) ?? "";
        const context: MockContext = {
          systemPrompt,
          messages,
          tools: Object.entries(this.tools).map(([name, entry]) => ({
            name,
            execute: async (_toolCallId: string, params: unknown) => entry.execute?.(params),
          })),
        };
        modelCallContext.push(context);

        const next = modelQueue.shift();
        if (!next) throw new Error("Missing mocked model response");
        const resolved = typeof next === "function" ? next(context) : next;
        if (resolved instanceof Error) throw resolved;

        const assistantMessage = {
          role: "assistant",
          content: resolved.content,
          timestamp: Date.now(),
        };
        messages.push(assistantMessage);

        const toolCalls = resolved.content.filter((block) => block.type === "toolCall");
        fullStreamParts.push({ type: "start-step" });
        const stepTextChunks: string[] = [];
        for (const block of resolved.content) {
          if (block.type === "thinking") {
            fullStreamParts.push({ type: "thinking", thinking: String(block.thinking ?? "") });
            continue;
          }
          if (block.type === "reasoning") {
            const value = String((block as { reasoning?: unknown }).reasoning ?? "");
            fullStreamParts.push({ type: "reasoning-start" });
            if (value) fullStreamParts.push({ type: "reasoning-delta", textDelta: value });
            fullStreamParts.push({ type: "reasoning-end" });
            continue;
          }
          if (block.type === "text") {
            const text = String(block.text ?? "");
            stepTextChunks.push(text);
            if (text) fullStreamParts.push({ type: "text-delta", text });
          }
        }
        const stepText = stepTextChunks.join("\n").trim();
        for (const toolCall of toolCalls) {
          fullStreamParts.push({
            type: "tool-call",
            id: String(toolCall.id ?? ""),
            toolName: String(toolCall.name ?? ""),
            input: (toolCall.arguments ?? {}) as Record<string, unknown>,
          });
        }
        for (const toolCall of toolCalls) {
          const toolCallId = String(toolCall.id ?? "");
          const toolName = String(toolCall.name ?? "");
          const toolArgs = (toolCall.arguments ?? {}) as Record<string, unknown>;
          await options.experimental_onToolCallStart?.({
            stepNumber: fullStreamParts.filter((part) => part.type === "start-step").length - 1,
            messages,
            toolCall: toolCall as Record<string, unknown>,
          });
          const tool = context.tools.find((entry) => entry.name === toolName);
          const output = tool ? await tool.execute(toolCallId, toolArgs) : { ok: false, error: `Missing tool: ${toolName}` };
          messages.push({
            role: "tool",
            content: JSON.stringify(output),
            toolCallId,
            toolName,
          });
        }

        await options.onStepFinish?.({ text: stepText, toolCalls });
        fullStreamParts.push({ type: "finish-step" });

        if (resolved.stopReason === "toolUse") continue;
        if (resolved.stopReason === "endTurn") {
          const text = resolved.content
            .filter((block) => block.type === "text")
            .map((block) => String(block.text ?? ""))
            .join("\n")
            .trim();
          return { text, response: { messages }, fullStreamParts };
        }
        throw new Error(resolved.errorMessage || "Agent failed");
      }
    }

    async stream(options: {
      messages?: Array<Record<string, unknown>>;
      onStepFinish?: (event: { text: string; toolCalls: Array<Record<string, unknown>> }) => Promise<void> | void;
      experimental_onToolCallStart?: (event: {
        stepNumber: number;
        messages: Array<Record<string, unknown>>;
        toolCall: Record<string, unknown>;
      }) => Promise<void> | void;
    }) {
      const runPromise = this.run(options);
      const textPromise = runPromise.then((result) => result.text);
      const responsePromise = runPromise.then((result) => result.response);
      void textPromise.catch(() => undefined);
      void responsePromise.catch(() => undefined);
      const textStream = (async function* () {
        const result = await runPromise;
        if (result.text) yield result.text;
      })();
      const fullStream = (async function* () {
        const result = await runPromise;
        for (const part of result.fullStreamParts) {
          yield part;
        }
      })();
      return {
        textStream,
        fullStream,
        text: textPromise,
        response: responsePromise,
      };
    }
  }

  return {
    ToolLoopAgent: MockToolLoopAgent,
    stepCountIs: (count: number) => ({ count }),
    tool: <T>(value: T) => value,
  };
});

const app = worker as unknown as {
  fetch(request: Request, env: unknown, ctx: ExecutionContext): Promise<Response>;
};

function makeUpdate(updateId: number, text: string, userId = 42) {
  return {
    update_id: updateId,
    message: {
      message_id: 1,
      date: 170000,
      chat: { id: 777, type: "private" },
      from: { id: userId },
      text,
    },
  };
}

function setupTelegramFetch(options: { draftFailures?: number } = {}) {
  const sends: Array<{ text: string; messageId: number; parseMode?: string }> = [];
  const drafts: Array<{ text: string; draftId: number; parseMode?: string }> = [];
  const actions: string[] = [];
  let nextMessageId = 100;
  let remainingDraftFailures = options.draftFailures ?? 0;

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/sendChatAction")) {
        actions.push("typing");
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url.includes("/sendMessageDraft")) {
        if (remainingDraftFailures > 0) {
          remainingDraftFailures -= 1;
          return new Response(JSON.stringify({ ok: false }), { status: 500 });
        }
        const body = init?.body
          ? (JSON.parse(String(init.body)) as { text?: string; parse_mode?: string; draft_id?: number })
          : {};
        drafts.push({ text: body.text ?? "", draftId: body.draft_id ?? 0, parseMode: body.parse_mode });
        return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
      }
      if (url.includes("/sendMessage")) {
        const body = init?.body ? (JSON.parse(String(init.body)) as { text?: string; parse_mode?: string }) : {};
        const messageId = nextMessageId;
        nextMessageId += 1;
        sends.push({ text: body.text ?? "", messageId, parseMode: body.parse_mode });
        return new Response(JSON.stringify({ ok: true, result: { message_id: messageId } }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }),
  );

  return { sends, drafts, actions };
}

async function callWebhook(env: ReturnType<typeof createEnv>["env"], updateId: number, text: string) {
  const req = new Request("https://test.local/telegram/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": env.TELEGRAM_WEBHOOK_SECRET,
    },
    body: JSON.stringify(makeUpdate(updateId, text)),
  });
  const res = await app.fetch(req, env, {} as ExecutionContext);
  expect(res.status).toBe(200);
}

describe("conversation e2e", () => {
  beforeEach(() => {
    modelCallContext.length = 0;
    modelQueue.length = 0;
  });

  it("uses compact progress by default and does not inject legacy custom context xml", async () => {
    const { env } = createEnv();
    const { sends, actions } = setupTelegramFetch();

    modelQueue.push({
      stopReason: "endTurn",
      content: [{ type: "text", text: "Saved it." }],
    });

    await callWebhook(env, 4001, "remember my name");

    expect(actions).toEqual(["typing"]);
    const final = sends.at(-1)!;
    expect(final.parseMode).toBe("HTML");
    expect(final.text).toContain("Saved it.");

    const systemPrompt = modelCallContext.at(0)?.systemPrompt ?? "";
    expect(systemPrompt).not.toContain("custom_context_manifest");
  });

  it("streams draft updates before sending final message", async () => {
    const { env } = createEnv();
    const { sends, drafts } = setupTelegramFetch();
    const longReply = "Draft stream " + "x".repeat(180);

    modelQueue.push({
      stopReason: "endTurn",
      content: [{ type: "text", text: longReply }],
    });

    await callWebhook(env, 4015, "stream please");

    expect(drafts.length).toBeGreaterThan(0);
    expect(drafts.at(-1)?.draftId).toBe(4015);
    expect(sends.at(-1)?.text).toContain("Draft stream");
  });

  it("falls back to final message when draft send fails", async () => {
    const { env } = createEnv();
    const { sends, drafts } = setupTelegramFetch({ draftFailures: 2 });
    const longReply = "Fallback stream " + "y".repeat(180);

    modelQueue.push({
      stopReason: "endTurn",
      content: [{ type: "text", text: longReply }],
    });

    await callWebhook(env, 4016, "stream fallback please");

    expect(drafts).toEqual([]);
    expect(sends.at(-1)?.text).toContain("Fallback stream");
  });

  it("sends interstitial assistant text before tool results continue", async () => {
    const { env } = createEnv();
    const { sends } = setupTelegramFetch();

    modelQueue.push(
      {
        stopReason: "toolUse",
        content: [
          { type: "text", text: "I'll quickly check that." },
          { type: "toolCall", id: "call-1", name: "search", arguments: { query: "pkg" } },
        ],
      },
      {
        stopReason: "endTurn",
        content: [{ type: "text", text: "Done." }],
      },
    );

    await callWebhook(env, 4030, "inspect runtime");

    expect(sends[0]?.text).toContain("I'll quickly check that.");
    expect(sends.at(-1)?.text).toContain("Done.");
    expect(sends.length).toBe(2);
  });

  it("sends multiple interstitial assistant texts across tool steps", async () => {
    const { env } = createEnv();
    const { sends } = setupTelegramFetch();

    modelQueue.push(
      {
        stopReason: "toolUse",
        content: [
          { type: "text", text: "First, checking runtime." },
          { type: "toolCall", id: "call-1", name: "search", arguments: { query: "pkg" } },
        ],
      },
      {
        stopReason: "toolUse",
        content: [
          { type: "text", text: "Now running a snippet." },
          { type: "toolCall", id: "call-2", name: "execute", arguments: { code: "1 + 1" } },
        ],
      },
      {
        stopReason: "endTurn",
        content: [{ type: "text", text: "All good." }],
      },
    );

    await callWebhook(env, 4031, "inspect runtime and execute");

    expect(sends[0]?.text).toContain("First, checking runtime.");
    expect(sends[1]?.text).toContain("Now running a snippet.");
    expect(sends[2]?.text).toContain("All good.");
    expect(sends.length).toBe(3);
  });

  it("does not send interstitial message when tool step has no text", async () => {
    const { env } = createEnv();
    const { sends } = setupTelegramFetch();

    modelQueue.push(
      {
        stopReason: "toolUse",
        content: [{ type: "toolCall", id: "call-1", name: "search", arguments: { query: "pkg" } }],
      },
      {
        stopReason: "endTurn",
        content: [{ type: "text", text: "Done." }],
      },
    );

    await callWebhook(env, 4032, "inspect runtime");

    expect(sends.length).toBe(1);
    expect(sends[0]?.text).toContain("Done.");
  });

  it("supports debug mode via /debug and shows tool previews + step summary", async () => {
    const { env } = createEnv();
    const { sends } = setupTelegramFetch();

    await callWebhook(env, 4009, "/debug on");

    modelQueue.push(
      {
        stopReason: "toolUse",
        content: [{ type: "toolCall", id: "call-1", name: "search", arguments: { query: "pkg" } }],
      },
      {
        stopReason: "endTurn",
        content: [{ type: "text", text: "Loaded." }],
      },
    );

    await callWebhook(env, 4010, "inspect runtime");

    expect(sends.some((message) => message.text.includes("Searching"))).toBe(true);
    expect(sends.some((message) => message.text.includes("Step:</b> tools=[search] ok=1 error=0"))).toBe(true);
    expect(sends.at(-1)?.text).toContain("Loaded.");
  });

  it("keeps assistant text before tool preview in debug mode", async () => {
    const { env } = createEnv();
    const { sends } = setupTelegramFetch();

    await callWebhook(env, 4090, "/debug on");

    modelQueue.push(
      {
        stopReason: "toolUse",
        content: [
          { type: "text", text: "INTERSTITIAL_ORDER_CHECK" },
          { type: "toolCall", id: "call-1", name: "search", arguments: { query: "pkg" } },
        ],
      },
      {
        stopReason: "endTurn",
        content: [{ type: "text", text: "Done." }],
      },
    );

    await callWebhook(env, 4091, "check order");

    const interstitialIndex = sends.findIndex((message) => message.text.includes("INTERSTITIAL_ORDER_CHECK"));
    const searchingIndex = sends.findIndex((message) => message.text.includes("Step:</b> tools=[search] ok=1 error=0"));
    expect(interstitialIndex).toBeGreaterThan(-1);
    expect(searchingIndex).toBeGreaterThan(-1);
  });

  it("disables debug mode via /debug off", async () => {
    const { env } = createEnv();
    const { sends } = setupTelegramFetch();

    await callWebhook(env, 4020, "/debug on");
    await callWebhook(env, 4021, "/debug off");

    modelQueue.push(
      {
        stopReason: "toolUse",
        content: [{ type: "toolCall", id: "call-1", name: "search", arguments: { query: "pkg" } }],
      },
      {
        stopReason: "endTurn",
        content: [{ type: "text", text: "Done." }],
      },
    );

    await callWebhook(env, 4022, "inspect runtime");

    expect(sends.some((message) => message.text.includes("Searching \"pkg\"..."))).toBe(false);
    expect(sends.some((message) => message.text.includes("Step:</b> tools=[search]"))).toBe(false);
  });

  it("persists tool errors in history so next turn can react", async () => {
    const { env } = createEnv();
    const { sends } = setupTelegramFetch();

    modelQueue.push(
      {
        stopReason: "toolUse",
        content: [{ type: "toolCall", id: "call-1", name: "execute", arguments: { code: "throw new Error('boom')" } }],
      },
      {
        stopReason: "endTurn",
        content: [{ type: "text", text: "Set failed." }],
      },
      (context: MockContext) => {
        const hasToolError = context.systemPrompt.includes("tool=execute");
        expect(hasToolError).toBe(true);
        return {
          stopReason: "endTurn",
          content: [{ type: "text", text: "I can see the previous tool error." }],
        };
      },
    );

    await callWebhook(env, 4013, "bad execute");
    await callWebhook(env, 4014, "what failed earlier?");
    expect(sends.at(-1)?.text).toContain("I can see the previous tool error.");
  });

  it("persists interstitial assistant text in context for the next turn", async () => {
    const { env } = createEnv();
    setupTelegramFetch();

    modelQueue.push(
      {
        stopReason: "toolUse",
        content: [
          { type: "text", text: "Interim note before tools." },
          { type: "toolCall", id: "call-1", name: "search", arguments: { query: "pkg" } },
        ],
      },
      {
        stopReason: "endTurn",
        content: [{ type: "text", text: "Done." }],
      },
      (context: MockContext) => {
        expect(context.systemPrompt).toContain("assistant: Interim note before tools.");
        return {
          stopReason: "endTurn",
          content: [{ type: "text", text: "Seen." }],
        };
      },
    );

    await callWebhook(env, 4033, "do tools");
    await callWebhook(env, 4034, "what did you say earlier?");
  });

  it("shows thinking blocks when /show-thinking on, even in compact mode", async () => {
    const { env } = createEnv();
    const { sends } = setupTelegramFetch();

    await callWebhook(env, 4008, "/show-thinking on");

    modelQueue.push({
      stopReason: "endTurn",
      content: [
        { type: "thinking", thinking: "Check markers then answer briefly." },
        { type: "text", text: "Done." },
      ],
    });

    await callWebhook(env, 4006, "think then answer");

    const thinkingMessages = sends.filter((message) => message.text.startsWith("<b>Thinking:</b>"));
    expect(thinkingMessages.length).toBe(1);
    expect(thinkingMessages[0]?.text).toContain("Check markers then answer briefly.");
    expect(sends.at(-1)?.text).toContain("Done.");
  });

  it("streams thinking in provider order around tool calls", async () => {
    const { env } = createEnv();
    const { sends } = setupTelegramFetch();

    await callWebhook(env, 4011, "/debug on");
    await callWebhook(env, 4012, "/show-thinking on");

    modelQueue.push(
      {
        stopReason: "toolUse",
        content: [
          { type: "thinking", thinking: "Think first." },
          { type: "text", text: "Before tool." },
          { type: "toolCall", id: "call-1", name: "search", arguments: { query: "pkg" } },
        ],
      },
      {
        stopReason: "endTurn",
        content: [
          { type: "thinking", thinking: "Think after tool." },
          { type: "text", text: "After tool." },
        ],
      },
    );

    await callWebhook(env, 4013, "ordered thinking");

    const ordered = sends.map((message) => message.text);
    const firstThinkingIndex = ordered.findIndex((text) => text.includes("Think first."));
    const beforeToolIndex = ordered.findIndex((text) => text.includes("Before tool."));
    const secondThinkingIndex = ordered.findIndex((text) => text.includes("Think after tool."));
    const afterToolIndex = ordered.findIndex((text) => text.includes("After tool."));

    expect(firstThinkingIndex).toBeGreaterThan(-1);
    expect(beforeToolIndex).toBeGreaterThan(firstThinkingIndex);
    expect(secondThinkingIndex).toBeGreaterThan(beforeToolIndex);
    expect(afterToolIndex).toBeGreaterThan(secondThinkingIndex);
  });

  it("shows reasoning-delta chunks from provider stream", async () => {
    const { env } = createEnv();
    const { sends } = setupTelegramFetch();

    await callWebhook(env, 4014, "/show-thinking on");

    modelQueue.push({
      stopReason: "endTurn",
      content: [
        { type: "reasoning", reasoning: "provider delta thought" },
        { type: "text", text: "Done." },
      ],
    });

    await callWebhook(env, 4015, "reasoning delta test");

    const thinkingMessages = sends.filter((message) => message.text.startsWith("<b>Thinking:</b>"));
    expect(thinkingMessages.length).toBe(1);
    expect(thinkingMessages[0]?.text).toContain("provider delta thought");
  });

  it("supports search and execute tools for code mode", async () => {
    const { env } = createEnv();
    const { sends } = setupTelegramFetch();

    modelQueue.push(
      {
        stopReason: "toolUse",
        content: [{ type: "toolCall", id: "call-1", name: "search", arguments: { query: "pkg" } }],
      },
      {
        stopReason: "toolUse",
        content: [
          {
              type: "toolCall",
              id: "call-2",
              name: "execute",
              arguments: {
                code: "await fs.write('/scripts/calc.js', 'export const calc = (value) => value + 2;', { overwrite: true });\nimport { calc } from 'vfs:/scripts/calc.js';\nconst value = await Promise.resolve(calc(1));\nglobalThis.__exec_result = { sum: value, inputName: input?.name ?? null, hasPkg: !!globalThis.pkg };\nglobalThis.__exec_result;",
                input: { name: "dre" },
              },
            },
        ],
      },
      {
        stopReason: "endTurn",
        content: [{ type: "text", text: "Executed." }],
      },
    );

    await callWebhook(env, 4130, "run code mode tools");
    expect(sends.at(-1)?.text).toContain("Executed.");
  });

  it("shows execute tool code block preview in debug mode", async () => {
    const { env } = createEnv();
    const { sends } = setupTelegramFetch();

    await callWebhook(env, 4131, "/debug on");

    modelQueue.push(
      {
        stopReason: "toolUse",
        content: [
          {
            type: "toolCall",
            id: "call-1",
            name: "execute",
            arguments: { code: "const total = 1 + 2;\nreturn total;" },
          },
        ],
      },
      {
        stopReason: "endTurn",
        content: [{ type: "text", text: "Done." }],
      },
    );

    await callWebhook(env, 4132, "run quick code");

    const codePreview = sends.find((message) => message.text.includes("<pre><code>const total = 1 + 2;"));
    expect(codePreview).toBeDefined();
    expect(sends.some((message) => message.text.includes("Step:</b> tools=[execute] ok=1 error=0"))).toBe(true);
    expect(sends.some((message) => message.text.includes("Result:</b>"))).toBe(true);
    expect(sends.at(-1)?.text).toContain("Done.");
  });

  it("handles /reset and /factory-reset commands", async () => {
    const { env } = createEnv();
    const { sends } = setupTelegramFetch();

    await callWebhook(env, 4018, "/reset");
    expect(sends.at(-1)?.text).toContain("Conversation context cleared");

    await callWebhook(env, 4021, "/factory-reset");
    expect(sends.at(-1)?.text).toContain("Factory reset complete");
  });

  it("handles /google connect command", async () => {
    const { env, db } = createEnv();
    const { sends } = setupTelegramFetch();

    await callWebhook(env, 4023, "/google connect");

    expect(db.oauthStates.size).toBe(1);
    const response = sends.at(-1)?.text ?? "";
    expect(response).toContain("Open this URL to connect Google:");
    expect(response).toContain("accounts.google.com");
  });

  it("handles /google status and /google disconnect commands", async () => {
    const { env, db } = createEnv();
    const { sends } = setupTelegramFetch();

    db.oauthTokens.set("default", {
      principal: "default",
      telegram_user_id: 42,
      refresh_token_ciphertext: "cipher",
      nonce: "nonce",
      scopes: "scopeA scopeB",
      updated_at: "2026-03-05T00:00:00.000Z",
    });

    await callWebhook(env, 4024, "/google status");
    expect(sends.at(-1)?.text).toContain("linked");

    await callWebhook(env, 4025, "/google disconnect");
    expect(sends.at(-1)?.text).toContain("disconnected");
    expect(db.oauthTokens.size).toBe(0);
  });

  it("persists runtime failures in history for future turns", async () => {
    const { env } = createEnv();
    const { sends } = setupTelegramFetch();

    modelQueue.push(
      new Error("boom"),
      (context: MockContext) => {
        const hasPriorFailure = context.systemPrompt.includes("Failed: boom");
        expect(hasPriorFailure).toBe(true);
        return {
          stopReason: "endTurn",
          content: [{ type: "text", text: "Recovered with context." }],
        };
      },
    );

    await callWebhook(env, 4004, "trigger failure");
    await callWebhook(env, 4005, "are you aware of that?");
    expect(sends.at(-1)?.text).toContain("Recovered with context.");
  });
});
