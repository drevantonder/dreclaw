import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/index";
import { createEnv } from "../helpers/fakes";

type MockContext = {
  systemPrompt: string;
  messages: Array<Record<string, unknown>>;
  tools: Array<{ name: string; execute: (toolCallId: string, params: unknown) => Promise<unknown> }>;
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

    constructor(options?: {
      initialState?: {
        systemPrompt?: string;
        messages?: Array<Record<string, unknown>>;
        tools?: Array<{ name: string; execute: (toolCallId: string, params: unknown) => Promise<unknown> }>;
        thinkingLevel?: string;
      };
    }) {
      this.state = {
        messages: [...(options?.initialState?.messages ?? [])],
        thinkingLevel: options?.initialState?.thinkingLevel,
      };
      (this as unknown as { __systemPrompt?: string }).__systemPrompt = options?.initialState?.systemPrompt ?? "";
      (this as unknown as { __tools?: Array<{ name: string; execute: (toolCallId: string, params: unknown) => Promise<unknown> }> }).__tools =
        options?.initialState?.tools ?? [];
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
          tools: (this as unknown as { __tools?: Array<{ name: string; execute: (toolCallId: string, params: unknown) => Promise<unknown> }> })
            .__tools ?? [],
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
          const toolCallId = String(toolCall.id ?? "");
          const toolName = String(toolCall.name ?? "");
          const toolArgs = (toolCall.arguments ?? {}) as Record<string, unknown>;
          this.emit({
            type: "tool_execution_start",
            toolCallId,
            toolName,
            args: toolArgs,
          });

          const tool = context.tools.find((entry) => entry.name === toolName);
          if (!tool) {
            const result = { content: [{ type: "text", text: `Missing tool: ${toolName}` }] };
            this.emit({
              type: "tool_execution_end",
              toolCallId,
              toolName,
              result,
              isError: true,
            });
            this.state.messages.push({
              role: "toolResult",
              toolCallId,
              toolName,
              content: result.content,
              isError: true,
              timestamp: Date.now(),
            });
            continue;
          }

          try {
            const result = (await tool.execute(toolCallId, toolArgs)) as { content?: Array<Record<string, unknown>> };
            this.emit({
              type: "tool_execution_end",
              toolCallId,
              toolName,
              result,
              isError: false,
            });
            this.state.messages.push({
              role: "toolResult",
              toolCallId,
              toolName,
              content: result.content ?? [{ type: "text", text: "ok" }],
              isError: false,
              timestamp: Date.now(),
            });
          } catch (error) {
            const text = error instanceof Error ? error.message : String(error ?? "tool failed");
            const result = { content: [{ type: "text", text }] };
            this.emit({
              type: "tool_execution_end",
              toolCallId,
              toolName,
              result,
              isError: true,
            });
            this.state.messages.push({
              role: "toolResult",
              toolCallId,
              toolName,
              content: result.content,
              isError: true,
              timestamp: Date.now(),
            });
          }
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
        const body = init?.body ? (JSON.parse(String(init.body)) as { text?: string; parse_mode?: string }) : {};
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

  it("uses compact progress by default and compiles custom context xml", async () => {
    const { env } = createEnv();
    const { sends, actions } = setupTelegramFetch();

    modelQueue.push({
      stopReason: "endTurn",
      content: [{ type: "text", text: "Saved it." }],
    });

    await callWebhook(env, 4001, "remember my name");

    expect(actions).toEqual(["typing"]);
    expect(sends.some((message) => message.text.includes("Tool call:"))).toBe(false);
    const final = sends.at(-1)!;
    expect(final.parseMode).toBe("HTML");
    expect(final.text).toContain("Saved it.");

    const firstContext = modelCallContext.at(0);
    const systemPrompt = firstContext?.systemPrompt ?? "";
    expect(systemPrompt).toContain('<custom_context_manifest version="1" count="3">');
    expect(systemPrompt).toContain('<custom_context id="identity">');
    expect(systemPrompt).toContain('<custom_context id="memory">');
    expect(systemPrompt).toContain('<custom_context id="soul">');
    expect(systemPrompt.indexOf('id="identity"')).toBeLessThan(systemPrompt.indexOf('id="memory"'));
    expect(systemPrompt.indexOf('id="memory"')).toBeLessThan(systemPrompt.indexOf('id="soul"'));
  });

  it("supports debug mode via /debug and shows custom_context tool lifecycle", async () => {
    const { env } = createEnv();
    const { sends } = setupTelegramFetch();

    await callWebhook(env, 4009, "/debug on");

    modelQueue.push(
      {
        stopReason: "toolUse",
        content: [{ type: "toolCall", id: "call-1", name: "custom_context_get", arguments: {} }],
      },
      {
        stopReason: "endTurn",
        content: [{ type: "text", text: "Loaded." }],
      },
    );

    await callWebhook(env, 4010, "show custom context");

    expect(sends.some((message) => message.text.includes("Tool call") && message.text.includes("custom_context_get"))).toBe(true);
    expect(sends.some((message) => message.text.includes("Tool ok") && message.text.includes("custom_context_get"))).toBe(true);
    expect(sends.at(-1)?.text).toContain("Loaded.");
  });

  it("disables debug mode via /debug off", async () => {
    const { env } = createEnv();
    const { sends } = setupTelegramFetch();

    await callWebhook(env, 4020, "/debug on");
    await callWebhook(env, 4021, "/debug off");

    modelQueue.push(
      {
        stopReason: "toolUse",
        content: [{ type: "toolCall", id: "call-1", name: "custom_context_get", arguments: {} }],
      },
      {
        stopReason: "endTurn",
        content: [{ type: "text", text: "Done." }],
      },
    );

    await callWebhook(env, 4022, "show custom context");

    expect(sends.some((message) => message.text.includes("Tool call") && message.text.includes("custom_context_get"))).toBe(false);
    expect(sends.some((message) => message.text.includes("Tool ok") && message.text.includes("custom_context_get"))).toBe(false);
  });

  it("supports custom_context.set then get", async () => {
    const { env } = createEnv();
    const { sends } = setupTelegramFetch();

    modelQueue.push(
      {
        stopReason: "toolUse",
        content: [
          {
            type: "toolCall",
            id: "call-1",
            name: "custom_context_set",
            arguments: {
              id: "identity",
              expected_version: 1,
              text: "New identity.",
            },
          },
        ],
      },
      {
        stopReason: "toolUse",
        content: [{ type: "toolCall", id: "call-2", name: "custom_context_get", arguments: {} }],
      },
      {
        stopReason: "endTurn",
        content: [{ type: "text", text: "Updated." }],
      },
    );

    await callWebhook(env, 4011, "update injected");
    expect(sends.at(-1)?.text).toContain("Updated.");

    modelQueue.push((context: MockContext) => {
      const hasNewIdentity = context.systemPrompt.includes("New identity.");
      expect(hasNewIdentity).toBe(true);
      return {
        stopReason: "endTurn",
        content: [{ type: "text", text: "Saw it." }],
      };
    });
    await callWebhook(env, 4012, "confirm");
    expect(sends.at(-1)?.text).toContain("Saw it.");
  });

  it("accepts text for custom_context_set", async () => {
    const { env } = createEnv();
    const { sends } = setupTelegramFetch();

    modelQueue.push(
      {
        stopReason: "toolUse",
        content: [
          {
            type: "toolCall",
            id: "call-1",
            name: "custom_context_set",
            arguments: {
              id: "memory",
              expected_version: 1,
              text: "The user prefers to be called Dre.",
            },
          },
        ],
      },
      {
        stopReason: "endTurn",
        content: [{ type: "text", text: "Saved simple memory." }],
      },
      (context: MockContext) => {
        const hasStringMemory = context.systemPrompt.includes("called Dre");
        expect(hasStringMemory).toBe(true);
        return {
          stopReason: "endTurn",
          content: [{ type: "text", text: "Memory present." }],
        };
      },
    );

    await callWebhook(env, 4120, "store simple memory");
    expect(sends.at(-1)?.text).toContain("Saved simple memory.");

    await callWebhook(env, 4121, "confirm");
    expect(sends.at(-1)?.text).toContain("Memory present.");
  });

  it("persists tool errors in history so next turn can react", async () => {
    const { env } = createEnv();
    const { sends } = setupTelegramFetch();

    modelQueue.push(
      {
        stopReason: "toolUse",
        content: [
          {
            type: "toolCall",
            id: "call-1",
            name: "custom_context_set",
            arguments: {
              id: "identity",
              expected_version: 999,
              text: "x",
            },
          },
        ],
      },
      {
        stopReason: "endTurn",
        content: [{ type: "text", text: "Set failed." }],
      },
      (context: MockContext) => {
        const hasToolError = context.systemPrompt.includes("tool=custom_context_set") && context.systemPrompt.includes("ok=false");
        expect(hasToolError).toBe(true);
        return {
          stopReason: "endTurn",
          content: [{ type: "text", text: "I can see the previous tool error." }],
        };
      },
    );

    await callWebhook(env, 4013, "bad set");
    expect(sends.some((message) => message.text.includes("Tool error: custom_context_set"))).toBe(false);

    await callWebhook(env, 4014, "what failed earlier?");
    expect(sends.at(-1)?.text).toContain("I can see the previous tool error.");
  });

  it("shows thinking when /thinking on, even in compact mode", async () => {
    const { env } = createEnv();
    const { sends } = setupTelegramFetch();

    await callWebhook(env, 4008, "/thinking on");

    modelQueue.push({
      stopReason: "endTurn",
      content: [
        { type: "thinking", thinking: "Check markers then answer briefly." },
        { type: "text", text: "Done." },
      ],
    });

    await callWebhook(env, 4006, "think then answer");

    const lastCall = modelCallOptions.at(-1);
    expect(lastCall?.thinkingLevel).toBe("medium");
    const thinkingMessages = sends.filter((message) => message.text.startsWith("<b>Thinking:</b>"));
    expect(thinkingMessages.length).toBe(1);
    expect(sends.at(-1)?.text).toContain("Done.");
  });

  it("supports custom_context.delete by id", async () => {
    const { env } = createEnv();
    const { sends } = setupTelegramFetch();

    modelQueue.push(
      {
        stopReason: "toolUse",
        content: [{ type: "toolCall", id: "call-1", name: "custom_context_delete", arguments: { id: "memory", expected_version: 1 } }],
      },
      {
        stopReason: "endTurn",
        content: [{ type: "text", text: "Deleted." }],
      },
      (context: MockContext) => {
        const hasMemoryMessage = context.systemPrompt.includes('<custom_context id="memory">');
        expect(hasMemoryMessage).toBe(false);
        return {
          stopReason: "endTurn",
          content: [{ type: "text", text: "Confirmed delete." }],
        };
      },
    );

    await callWebhook(env, 4015, "delete memory");
    expect(sends.at(-1)?.text).toContain("Deleted.");

    await callWebhook(env, 4016, "confirm memory deleted");
    expect(sends.at(-1)?.text).toContain("Confirmed delete.");
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
              code: "globalThis.__exec_result = { sum: 1 + 2, inputName: input?.name ?? null, hasPkg: !!globalThis.pkg }",
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

  it("keeps custom context across /reset", async () => {
    const { env } = createEnv();
    const { sends } = setupTelegramFetch();

    modelQueue.push(
      {
        stopReason: "toolUse",
        content: [
          {
            type: "toolCall",
            id: "call-1",
            name: "custom_context_set",
            arguments: {
              id: "identity",
              expected_version: 1,
              text: "# IDENTITY\n\nPersist me.",
            },
          },
        ],
      },
      {
        stopReason: "endTurn",
        content: [{ type: "text", text: "Stored." }],
      },
      (context: MockContext) => {
        const hasPersistedIdentity = context.systemPrompt.includes("Persist me.");
        expect(hasPersistedIdentity).toBe(true);
        return {
          stopReason: "endTurn",
          content: [{ type: "text", text: "Still here." }],
        };
      },
    );

    await callWebhook(env, 4017, "set identity");
    expect(sends.at(-1)?.text).toContain("Stored.");

    await callWebhook(env, 4018, "/reset");
    expect(sends.at(-1)?.text).toContain("Conversation context cleared");

    await callWebhook(env, 4019, "confirm persisted identity");
    expect(sends.at(-1)?.text).toContain("Still here.");
  });

  it("resets custom context on /factory-reset", async () => {
    const { env } = createEnv();
    const { sends } = setupTelegramFetch();

    modelQueue.push(
      {
        stopReason: "toolUse",
        content: [
          {
            type: "toolCall",
            id: "call-1",
            name: "custom_context_set",
            arguments: {
              id: "identity",
              expected_version: 1,
              text: "# IDENTITY\n\nPersist me.",
            },
          },
        ],
      },
      {
        stopReason: "endTurn",
        content: [{ type: "text", text: "Stored." }],
      },
      (context: MockContext) => {
        const hasPersistedIdentity = context.systemPrompt.includes("Persist me.");
        expect(hasPersistedIdentity).toBe(false);
        return {
          stopReason: "endTurn",
          content: [{ type: "text", text: "Defaults restored." }],
        };
      },
    );

    await callWebhook(env, 4020, "set identity");
    expect(sends.at(-1)?.text).toContain("Stored.");

    await callWebhook(env, 4021, "/factory-reset");
    expect(sends.at(-1)?.text).toContain("Factory reset complete");

    await callWebhook(env, 4022, "confirm defaults");
    expect(sends.at(-1)?.text).toContain("Defaults restored.");
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
    expect(sends.some((message) => message.text.includes("<b>Failed:</b> boom"))).toBe(true);

    await callWebhook(env, 4005, "are you aware of that?");
    expect(sends.at(-1)?.text).toContain("Recovered with context.");
  });
});
