import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createEnv } from "../helpers/fakes";

const mocks = vi.hoisted(() => ({
  createPluginRegistry: vi.fn(),
  getOAuthCallbackHandler: vi.fn(),
  handleOAuthCallback: vi.fn(),
  sendTelegramTextMessage: vi.fn(),
}));

vi.mock("../../src/core", () => ({
  createPluginRegistry: mocks.createPluginRegistry,
}));

vi.mock("../../src/chat-adapters/telegram/api", () => ({
  sendTelegramTextMessage: mocks.sendTelegramTextMessage,
}));

import { handleGoogleOAuthCallbackRequest } from "../../src/cloudflare/http/controllers/google-oauth-callback";

describe("handleGoogleOAuthCallbackRequest", () => {
  beforeEach(() => {
    mocks.createPluginRegistry.mockReset();
    mocks.getOAuthCallbackHandler.mockReset();
    mocks.handleOAuthCallback.mockReset();
    mocks.sendTelegramTextMessage.mockReset();
    mocks.createPluginRegistry.mockReturnValue({
      getOAuthCallbackHandler: mocks.getOAuthCallbackHandler,
    });
    mocks.getOAuthCallbackHandler.mockReturnValue(mocks.handleOAuthCallback);
  });

  it("delegates callback handling to the google module", async () => {
    const { env } = createEnv();
    mocks.handleOAuthCallback.mockResolvedValue({
      status: 200,
      title: "Google OAuth complete",
      body: "You can close this tab and return to Telegram.",
    });
    const request = new Request(
      "https://test.local/google/oauth/callback?state=test-state&code=test-code",
    );

    const response = await handleGoogleOAuthCallbackRequest(request, env);

    expect(response.status).toBe(200);
    expect(mocks.createPluginRegistry).toHaveBeenCalledWith(env);
    expect(mocks.getOAuthCallbackHandler).toHaveBeenCalledWith("google");
    expect(mocks.handleOAuthCallback).toHaveBeenCalledWith(request);
  });
});
