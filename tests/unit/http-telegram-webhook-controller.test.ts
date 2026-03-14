import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createEnv } from "../helpers/fakes";

const mocks = vi.hoisted(() => ({
  createBot: vi.fn(),
  maybeHandleAsyncTelegramCommand: vi.fn(),
  markUpdateSeen: vi.fn(),
}));

vi.mock("../../src/chat-adapters/telegram/gateway", () => ({
  createBot: mocks.createBot,
}));

vi.mock("../../src/chat-adapters/telegram/commands", () => ({
  maybeHandleAsyncTelegramCommand: mocks.maybeHandleAsyncTelegramCommand,
}));

vi.mock("../../src/chat-adapters/telegram/repo", () => ({
  markUpdateSeen: mocks.markUpdateSeen,
}));

import { handleTelegramWebhookRequest } from "../../src/chat-adapters/telegram/webhook";

function createCtx() {
  return {
    waitUntil: vi.fn(),
    passThroughOnException() {
      return;
    },
    props: {},
  } as unknown as ExecutionContext;
}

function createRequest(secret: string, updateId = 1, text = "hello") {
  return new Request("https://test.local/telegram/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": secret,
    },
    body: JSON.stringify({
      update_id: updateId,
      message: {
        message_id: updateId,
        date: 170000,
        text,
        chat: { id: 777, type: "private" },
        from: { id: 42 },
      },
    }),
  });
}

describe("handleTelegramWebhookRequest", () => {
  beforeEach(() => {
    mocks.createBot.mockReset();
    mocks.maybeHandleAsyncTelegramCommand.mockReset();
    mocks.markUpdateSeen.mockReset();
  });

  it("rejects requests with the wrong webhook secret", async () => {
    const { env } = createEnv();
    const response = await handleTelegramWebhookRequest(createRequest("wrong"), env, createCtx());

    expect(response.status).toBe(401);
    expect(mocks.markUpdateSeen).not.toHaveBeenCalled();
    expect(mocks.maybeHandleAsyncTelegramCommand).not.toHaveBeenCalled();
    expect(mocks.createBot).not.toHaveBeenCalled();
  });

  it("dedupes duplicate webhook deliveries before dispatch", async () => {
    const { env } = createEnv();
    mocks.markUpdateSeen.mockResolvedValue(false);

    const response = await handleTelegramWebhookRequest(
      createRequest(env.TELEGRAM_WEBHOOK_SECRET),
      env,
      createCtx(),
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
    expect(mocks.maybeHandleAsyncTelegramCommand).not.toHaveBeenCalled();
    expect(mocks.createBot).not.toHaveBeenCalled();
  });

  it("short-circuits async telegram commands", async () => {
    const { env } = createEnv();
    const ctx = createCtx();
    mocks.markUpdateSeen.mockResolvedValue(true);
    mocks.maybeHandleAsyncTelegramCommand.mockResolvedValue(true);

    const request = createRequest(env.TELEGRAM_WEBHOOK_SECRET, 9, "/help");
    const response = await handleTelegramWebhookRequest(request, env, ctx);

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
    expect(mocks.maybeHandleAsyncTelegramCommand).toHaveBeenCalledWith(
      env,
      expect.objectContaining({ update_id: 9 }),
      expect.any(Function),
      ctx,
    );
    expect(mocks.createBot).not.toHaveBeenCalled();
  });

  it("dispatches non-command updates to the bot webhook adapter", async () => {
    const { env } = createEnv();
    const ctx = createCtx() as ExecutionContext & { waitUntil: ReturnType<typeof vi.fn> };
    const botResponse = new Response("bot", { status: 202 });
    const telegramWebhook = vi.fn(
      async (_request: Request, options: { waitUntil(task: Promise<unknown>): void }) => {
        options.waitUntil(Promise.resolve("scheduled"));
        return botResponse;
      },
    );

    mocks.markUpdateSeen.mockResolvedValue(true);
    mocks.maybeHandleAsyncTelegramCommand.mockResolvedValue(false);
    mocks.createBot.mockReturnValue({
      webhooks: {
        telegram: telegramWebhook,
      },
    });

    const request = createRequest(env.TELEGRAM_WEBHOOK_SECRET, 11, "hello");
    const response = await handleTelegramWebhookRequest(request, env, ctx);

    expect(response).toBe(botResponse);
    expect(mocks.createBot).toHaveBeenCalledWith(env, ctx);
    expect(telegramWebhook).toHaveBeenCalledWith(request, { waitUntil: expect.any(Function) });
    expect(ctx.waitUntil).toHaveBeenCalledTimes(1);
  });
});
