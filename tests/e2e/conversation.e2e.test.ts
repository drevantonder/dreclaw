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
  const sends: Array<{ text: string }> = [];
  const actions: string[] = [];

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
        sends.push({ text: body.text ?? "" });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
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

  it("shows tool calls to the user in real conversation replies", async () => {
    const { env } = createEnv();
    const { sends, actions } = setupTelegramFetch();

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
    expect(sends.some((message) => message.text.includes("Tool call: write"))).toBe(true);
    expect(sends.some((message) => message.text.includes("Tool ok: write"))).toBe(true);
    const final = sends.at(-1)!;
    expect(final.text).toContain("Saved it.");
    expect(final.text).toContain("Tools used:");
    expect(final.text).toContain("- write");
    expect(final.text).toContain("-> ok");
  });

  it("streams bash tool result and still sends final reply", async () => {
    const { env } = createEnv();
    const { sends } = setupTelegramFetch();

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

    expect(sends.some((message) => message.text.includes("Tool call: bash"))).toBe(true);
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
    expect(sends.some((message) => message.text.includes("Tool call: read"))).toBe(true);
    expect(sends.some((message) => message.text.includes("Tool error: read"))).toBe(true);
    const firstFinal = sends.find((message) => message.text.includes("Tools used:"));
    expect(firstFinal?.text).toContain("-> failed");

    await callWebhook(env, 4003, "what failed earlier?");
    expect(sends.at(-1)?.text).toContain("I can see the previous tool error.");
  });

  it("sends thinking updates and enables reasoning", async () => {
    const { env } = createEnv();
    const { sends } = setupTelegramFetch();

    modelQueue.push({
      stopReason: "endTurn",
      content: [
        { type: "thinking", thinking: "Check memory note then answer briefly." },
        { type: "text", text: "Done." },
      ],
    });

    await callWebhook(env, 4006, "think then answer");

    expect(modelCallOptions[0]?.reasoningEffort).toBe("medium");
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
    expect(sends[0].text).toContain("Failed: boom");

    await callWebhook(env, 4005, "are you aware of that?");
    expect(sends[1].text).toContain("Recovered with context.");
  });
});
