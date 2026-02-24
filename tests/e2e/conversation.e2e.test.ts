import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/index";
import { createEnv } from "../helpers/fakes";

type MockContext = {
  systemPrompt: string;
  messages: Array<Record<string, unknown>>;
  tools: Array<Record<string, unknown>>;
};

type MockOptions = {
  thinkingLevel?: string;
};

type MockAssistant = {
  stopReason: "endTurn" | "toolUse" | "error" | "aborted";
  content: Array<Record<string, unknown>>;
  errorMessage?: string;
};

const { modelCallContext, modelCallOptions, modelQueue } = vi.hoisted(() => {
  const callContext: MockContext[] = [];
  const callOptions: MockOptions[] = [];
  const queue: Array<MockAssistant | Error | ((context: MockContext) => MockAssistant | Error)> = [];
  return {
    modelCallContext: callContext,
    modelCallOptions: callOptions,
    modelQueue: queue,
  };
});

vi.mock("@mariozechner/pi-ai", () => ({
  getModel: (_provider: string, id: string) => ({
    id,
    name: id,
    provider: "opencode",
    api: "openai-completions",
    baseUrl: "https://opencode.ai/zen/v1",
  }),
}));

vi.mock("@mariozechner/pi-agent-core", () => {
  class MockAgent {
    state: { messages: Array<Record<string, unknown>>; thinkingLevel?: string };

    private listeners = new Set<(event: Record<string, unknown>) => void>();

    constructor(options?: { initialState?: { systemPrompt?: string; messages?: Array<Record<string, unknown>>; tools?: Array<Record<string, unknown>>; thinkingLevel?: string } }) {
      this.state = {
        messages: [...(options?.initialState?.messages ?? [])],
        thinkingLevel: options?.initialState?.thinkingLevel,
      };
      (this as unknown as { __systemPrompt?: string }).__systemPrompt = options?.initialState?.systemPrompt ?? "";
      (this as unknown as { __tools?: Array<Record<string, unknown>> }).__tools = options?.initialState?.tools ?? [];
    }

    subscribe(listener: (event: Record<string, unknown>) => void) {
      this.listeners.add(listener);
      return () => this.listeners.delete(listener);
    }

    private emit(event: Record<string, unknown>) {
      for (const listener of this.listeners) listener(event);
    }

    async prompt(input: string) {
      const userMessage = {
        role: "user",
        content: [{ type: "text", text: input }],
        timestamp: Date.now(),
      };
      this.state.messages.push(userMessage);

      while (true) {
        const context: MockContext = {
          systemPrompt: (this as unknown as { __systemPrompt?: string }).__systemPrompt ?? "",
          messages: this.state.messages,
          tools: (this as unknown as { __tools?: Array<Record<string, unknown>> }).__tools ?? [],
        };
        modelCallContext.push(context);
        modelCallOptions.push({ thinkingLevel: this.state.thinkingLevel });

        const next = modelQueue.shift();
        if (!next) throw new Error("Missing mocked model response");
        const resolved = typeof next === "function" ? next(context) : next;
        if (resolved instanceof Error) throw resolved;

        const assistantMessage = {
          role: "assistant",
          content: resolved.content,
          timestamp: Date.now(),
        };
        this.emit({ type: "message_start", message: assistantMessage });
        for (const block of resolved.content) {
          if (block.type === "thinking") {
            this.emit({
              type: "message_update",
              message: assistantMessage,
              assistantMessageEvent: { type: "thinking_start" },
            });
            const chunks = String(block.thinking ?? "").split(/(\s+)/).filter(Boolean);
            for (const chunk of chunks) {
              this.emit({
                type: "message_update",
                message: assistantMessage,
                assistantMessageEvent: { type: "thinking_delta", delta: chunk },
              });
            }
            this.emit({
              type: "message_update",
              message: assistantMessage,
              assistantMessageEvent: { type: "thinking_end" },
            });
          }
        }
        this.emit({ type: "message_end", message: assistantMessage });
        this.state.messages.push(assistantMessage);

        const toolCalls = resolved.content.filter((block) => block.type === "toolCall");
        for (const toolCall of toolCalls) {
          const toolArgs = (toolCall.arguments ?? {}) as Record<string, unknown>;
          this.emit({
            type: "tool_execution_start",
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            args: toolArgs,
          });
          const isReadMissing = toolCall.name === "read" && toolArgs.path === "/missing.md";
          const resultText = isReadMissing
            ? "tool=read\nok=false\nerror=ENOENT: no such file or directory, open '/missing.md'"
            : "ok";
          this.emit({
            type: "tool_execution_end",
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            result: { content: [{ type: "text", text: resultText }], details: {} },
            isError: isReadMissing,
          });
          this.state.messages.push({
            role: "toolResult",
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            content: [{ type: "text", text: resultText }],
            isError: isReadMissing,
            timestamp: Date.now(),
          });
        }

        if (resolved.stopReason === "toolUse") continue;
        if (resolved.stopReason === "endTurn") return;
        throw new Error(resolved.errorMessage || "Agent failed");
      }
    }
  }

  return { Agent: MockAgent };
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

function setupTelegramFetch() {
  const sends: Array<{ text: string; messageId: number; parseMode?: string }> = [];
  const actions: string[] = [];
  let nextMessageId = 100;

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/sendChatAction")) {
        actions.push("typing");
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url.includes("/sendMessage")) {
        const body = init?.body ? JSON.parse(String(init.body)) as { text?: string; parse_mode?: string } : {};
        const messageId = nextMessageId;
        nextMessageId += 1;
        sends.push({ text: body.text ?? "", messageId, parseMode: body.parse_mode });
        return new Response(JSON.stringify({ ok: true, result: { message_id: messageId } }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }),
  );

  return { sends, actions };
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
    modelCallOptions.length = 0;
    modelQueue.length = 0;
  });

  it("uses compact progress and final tool summary by default", async () => {
    const { env } = createEnv();
    const { sends, actions } = setupTelegramFetch();

    modelQueue.push(
      {
        stopReason: "toolUse",
        content: [{ type: "toolCall", id: "call-1", name: "write", arguments: { path: "/MEMORY.md", content: "human_name: Dre" } }],
      },
      {
        stopReason: "endTurn",
        content: [{ type: "text", text: "Saved it." }],
      },
    );

    await callWebhook(env, 4001, "remember my name");

    expect(actions).toEqual(["typing"]);
    expect(sends.some((message) => message.text === "Working..." || message.text === "Wrapping up...")).toBe(false);
    expect(sends.some((message) => message.text.includes("Tool call:"))).toBe(false);
    const final = sends.at(-1)!;
    expect(final.parseMode).toBe("HTML");
    expect(final.text).toContain("Saved it.");
    expect(final.text).toContain("Tools used: write");
    expect(final.text).not.toContain("-> ok");

    const firstContext = modelCallContext.at(0);
    const assistantBootstrap = firstContext?.messages.find(
      (message) =>
        message.role === "assistant" &&
        Array.isArray(message.content) &&
        message.content.some((block: Record<string, unknown>) => block.type === "toolCall" && block.name === "read"),
    );
    expect(assistantBootstrap).toBeTruthy();

    const bootstrapCalls = ((assistantBootstrap as { content?: Array<Record<string, unknown>> } | undefined)?.content ?? [])
      .filter((block) => block.type === "toolCall" && block.name === "read")
      .map((block) => ((block.arguments as Record<string, unknown> | undefined)?.path as string | undefined) ?? "");
    expect(bootstrapCalls).toEqual(["/SOUL.md", "/MEMORY.md"]);
  });

  it("supports verbose mode via /details and shows tool lifecycle messages", async () => {
    const { env } = createEnv();
    const { sends } = setupTelegramFetch();

    await callWebhook(env, 4009, "/details verbose");

    modelQueue.push(
      {
        stopReason: "toolUse",
        content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "cat /MEMORY.md" } }],
      },
      {
        stopReason: "endTurn",
        content: [{ type: "text", text: "Memory loaded." }],
      },
    );

    await callWebhook(env, 4010, "Can you see any memories?");

    expect(sends.some((message) => message.parseMode === "HTML")).toBe(true);
    expect(sends.some((message) => message.text.includes("Tool start:"))).toBe(true);
    expect(sends.some((message) => message.text.includes("Tool ok:") || message.text.includes("Tool error:"))).toBe(true);
    expect(sends.at(-1)?.text).toContain("Memory loaded.");
  });

  it("persists tool errors in history so next turn can react", async () => {
    const { env } = createEnv();
    const { sends } = setupTelegramFetch();

    modelQueue.push(
      {
        stopReason: "toolUse",
        content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "/missing.md" } }],
      },
      {
        stopReason: "endTurn",
        content: [{ type: "text", text: "I could not read that file." }],
      },
      (context: MockContext) => {
        const hasToolError = context.systemPrompt.includes("tool=read") && context.systemPrompt.includes("ok=false");
        expect(hasToolError).toBe(true);
        return {
          stopReason: "endTurn",
          content: [{ type: "text", text: "I can see the previous tool error." }],
        };
      },
    );

    await callWebhook(env, 4002, "read /missing.md");
    expect(sends.some((message) => message.text.includes("Tool error: read"))).toBe(false);
    const firstFinal = sends.find((message) => message.text.includes("Tools used:"));
    expect(firstFinal?.text).toContain("Failed tools: read");

    await callWebhook(env, 4003, "what failed earlier?");
    expect(sends.at(-1)?.text).toContain("I can see the previous tool error.");
  });

  it("shows thinking only when /thinking on and /details debug", async () => {
    const { env } = createEnv();
    const { sends } = setupTelegramFetch();

    await callWebhook(env, 4007, "/details debug");

    await callWebhook(env, 4008, "/thinking on");

    modelQueue.push({
      stopReason: "endTurn",
      content: [
        { type: "thinking", thinking: "Check memory note then answer briefly." },
        { type: "text", text: "Done." },
      ],
    });

    await callWebhook(env, 4006, "think then answer");

    const lastCall = modelCallOptions.at(-1);
    expect(lastCall?.thinkingLevel).toBe("medium");
    const thinkingMessages = sends.filter((message) => message.text.startsWith("Thinking:"));
    expect(thinkingMessages.length).toBe(1);
    expect(sends.at(-1)?.text).toContain("Done.");
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
    expect(sends.some((message) => message.text.includes("Failed: boom"))).toBe(true);

    await callWebhook(env, 4005, "are you aware of that?");
    expect(sends.at(-1)?.text).toContain("Recovered with context.");
  });
});
