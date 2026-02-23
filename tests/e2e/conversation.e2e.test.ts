import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/index";
import { createEnv } from "../helpers/fakes";

type MockContext = {
  systemPrompt: string;
  messages: Array<Record<string, unknown>>;
  tools: Array<Record<string, unknown>>;
};

type MockOptions = {
  reasoningEffort?: string;
};

type MockAssistant = {
  stopReason: "endTurn" | "toolUse" | "error" | "aborted";
  content: Array<Record<string, unknown>>;
  errorMessage?: string;
};

const { modelCallContext, modelCallOptions, modelQueue, piCompleteMock } = vi.hoisted(() => {
  const callContext: MockContext[] = [];
  const callOptions: MockOptions[] = [];
  const queue: Array<MockAssistant | Error | ((context: MockContext) => MockAssistant | Error)> = [];
  const completeMock = vi.fn(async (_model: unknown, context: MockContext, options: MockOptions) => {
    callContext.push(context);
    callOptions.push(options ?? {});
    const next = queue.shift();
    if (!next) throw new Error("Missing mocked model response");

    const resolved = typeof next === "function" ? next(context) : next;
    if (resolved instanceof Error) throw resolved;
    return resolved;
  });
  return {
    modelCallContext: callContext,
    modelCallOptions: callOptions,
    modelQueue: queue,
    piCompleteMock: completeMock,
  };
});

vi.mock("@mariozechner/pi-ai", () => ({
  complete: piCompleteMock,
  getModel: (_provider: string, id: string) => ({
    id,
    name: id,
    baseUrl: "https://opencode.ai/zen/v1",
  }),
}));

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
  const sends: Array<{ text: string; messageId: number }> = [];
  const edits: Array<{ text: string; messageId: number }> = [];
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
        const body = init?.body ? JSON.parse(String(init.body)) as { text?: string } : {};
        const messageId = nextMessageId;
        nextMessageId += 1;
        sends.push({ text: body.text ?? "", messageId });
        return new Response(JSON.stringify({ ok: true, result: { message_id: messageId } }), { status: 200 });
      }
      if (url.includes("/editMessageText")) {
        const body = init?.body
          ? JSON.parse(String(init.body)) as { text?: string; message_id?: number }
          : {};
        edits.push({ text: body.text ?? "", messageId: body.message_id ?? -1 });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    }),
  );

  return { sends, edits, actions };
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
    const { sends, edits, actions } = setupTelegramFetch();

    modelQueue.push(
      {
        stopReason: "toolUse",
        content: [{ type: "toolCall", id: "call-1", name: "write", arguments: { path: "/memory/persons/dre.md", content: "name: Dre" } }],
      },
      {
        stopReason: "endTurn",
        content: [{ type: "text", text: "Saved it." }],
      },
    );

    await callWebhook(env, 4001, "remember my name");

    expect(actions).toEqual(["typing"]);
    expect(edits.some((message) => message.text.includes("Working..."))).toBe(true);
    expect(sends.some((message) => message.text.includes("Tool call:"))).toBe(false);
    const final = sends.at(-1)!;
    expect(final.text).toContain("Saved it.");
    expect(final.text).toContain("Tools used: write");
    expect(final.text).not.toContain("-> ok");
  });

  it("supports verbose mode via /details and shows tool lifecycle messages", async () => {
    const { env } = createEnv();
    const { sends } = setupTelegramFetch();

    await callWebhook(env, 4009, "/details verbose");

    modelQueue.push(
      {
        stopReason: "toolUse",
        content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: "ls -la /memory 2>/dev/null || echo \"No memory directory found\"" } }],
      },
      {
        stopReason: "endTurn",
        content: [{ type: "text", text: "No saved memories yet." }],
      },
    );

    await callWebhook(env, 4010, "Can you see any memories?");

    expect(sends.some((message) => message.text.includes("Tool start: bash"))).toBe(true);
    expect(sends.some((message) => message.text.includes("Tool ok: bash") || message.text.includes("Tool error: bash"))).toBe(true);
    expect(sends.at(-1)?.text).toContain("No saved memories yet.");
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
        const hasToolError = context.messages.some((message) => {
          if (message.role !== "toolResult") return false;
          if (message.isError !== true) return false;
          const text = JSON.stringify(message.content ?? "");
          return text.includes("tool=read") && text.includes("ok=false");
        });
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
    expect(lastCall?.reasoningEffort).toBe("medium");
    expect(sends.some((message) => message.text.includes("Thinking:"))).toBe(true);
    expect(sends.at(-1)?.text).toContain("Done.");
  });

  it("persists runtime failures in history for future turns", async () => {
    const { env } = createEnv();
    const { sends } = setupTelegramFetch();

    modelQueue.push(
      new Error("boom"),
      new Error("boom"),
      (context: MockContext) => {
        const hasPriorFailure = context.messages.some((message) => {
          if (message.role !== "assistant") return false;
          const content = JSON.stringify(message.content ?? "");
          return content.includes("Failed: boom");
        });
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
