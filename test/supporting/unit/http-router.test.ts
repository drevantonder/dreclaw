import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createEnv } from "../../helpers/fakes";

const mocks = vi.hoisted(() => ({
  handlePluginOAuthCallback: vi.fn(),
  sendTelegramTextMessage: vi.fn(),
  handleTelegramWebhookRequest: vi.fn(),
}));

vi.mock("../../../src/core/http", () => ({
  getHealthPayload: () => ({ ok: true, service: "dreclaw", ts: 123 }),
  handlePluginOAuthCallback: mocks.handlePluginOAuthCallback,
}));

vi.mock("../../../src/chat-adapters/telegram/api", () => ({
  sendTelegramTextMessage: mocks.sendTelegramTextMessage,
}));

vi.mock("../../../src/chat-adapters/telegram/webhook", () => ({
  handleTelegramWebhookRequest: mocks.handleTelegramWebhookRequest,
}));

import { handleHttpRequest } from "../../../src/cloudflare/http/router";

describe("handleHttpRequest", () => {
  beforeEach(() => {
    mocks.handlePluginOAuthCallback.mockReset();
    mocks.sendTelegramTextMessage.mockReset();
    mocks.handleTelegramWebhookRequest.mockReset();
  });

  it("delegates callback handling to the google module", async () => {
    const { env } = createEnv();
    mocks.handlePluginOAuthCallback.mockResolvedValue({
      status: 200,
      title: "Google OAuth complete",
      body: "You can close this tab and return to Telegram.",
    });
    const request = new Request(
      "https://test.local/google/oauth/callback?state=test-state&code=test-code",
    );

    const response = await handleHttpRequest(request, env, {} as ExecutionContext);

    expect(response.status).toBe(200);
    expect(mocks.handlePluginOAuthCallback).toHaveBeenCalledWith(
      expect.anything(),
      "google",
      request,
    );
  });

  it("returns health payload through the edge router", async () => {
    const { env } = createEnv();

    const response = await handleHttpRequest(
      new Request("https://test.local/health"),
      env,
      {} as ExecutionContext,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, service: "dreclaw", ts: 123 });
  });

  it("delegates telegram webhooks to the telegram adapter", async () => {
    const { env } = createEnv();
    const expected = new Response("ok", { status: 202 });
    mocks.handleTelegramWebhookRequest.mockResolvedValue(expected);
    const request = new Request("https://test.local/telegram/webhook", { method: "POST" });
    const ctx = {} as ExecutionContext;

    const response = await handleHttpRequest(request, env, ctx);

    expect(response).toBe(expected);
    expect(mocks.handleTelegramWebhookRequest).toHaveBeenCalledWith(request, env, ctx);
  });
});
