import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/index";
import { createEnv } from "../helpers/fakes";

type MockContext = {
  systemPrompt: string;
  messages: Array<Record<string, unknown>>;
  tools: Array<Record<string, unknown>>;
};

type MockAssistant = {
  stopReason: "endTurn" | "toolUse" | "error" | "aborted";
  content: Array<Record<string, unknown>>;
  errorMessage?: string;
};

const { modelCallContext, modelQueue, piCompleteMock } = vi.hoisted(() => {
  const callContext: MockContext[] = [];
  const queue: Array<MockAssistant | Error | ((context: MockContext) => MockAssistant | Error)> = [];
  const completeMock = vi.fn(async (_model: unknown, context: MockContext) => {
    callContext.push(context);
    const next = queue.shift();
    if (!next) throw new Error("Missing mocked model response");

    const resolved = typeof next === "function" ? next(context) : next;
    if (resolved instanceof Error) throw resolved;
    return resolved;
  });
  return {
    modelCallContext: callContext,
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
    expect(sends).toHaveLength(1);
    expect(sends[0].text).toContain("Saved it.");
    expect(sends[0].text).toContain("Tools used:");
    expect(sends[0].text).toContain("- write");
    expect(sends[0].text).toContain("-> ok");
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
    expect(sends[0].text).toContain("Tools used:");
    expect(sends[0].text).toContain("-> failed");

    await callWebhook(env, 4003, "what failed earlier?");
    expect(sends[1].text).toContain("I can see the previous tool error.");
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
