import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createEnv } from "../helpers/fakes";

const mocks = vi.hoisted(() => ({
  decodeEncryptionKey: vi.fn(),
  encryptSecret: vi.fn(),
  getGoogleOAuthState: vi.fn(),
  markGoogleOAuthStateUsed: vi.fn(),
  upsertGoogleOAuthToken: vi.fn(),
  exchangeGoogleOAuthCode: vi.fn(),
  getGoogleOAuthConfig: vi.fn(),
  sendTelegramTextMessage: vi.fn(),
}));

vi.mock("../../src/integrations/google/crypto", () => ({
  decodeEncryptionKey: mocks.decodeEncryptionKey,
  encryptSecret: mocks.encryptSecret,
}));

vi.mock("../../src/integrations/google/repo", () => ({
  getGoogleOAuthState: mocks.getGoogleOAuthState,
  markGoogleOAuthStateUsed: mocks.markGoogleOAuthStateUsed,
  upsertGoogleOAuthToken: mocks.upsertGoogleOAuthToken,
}));

vi.mock("../../src/integrations/google/oauth", () => ({
  exchangeGoogleOAuthCode: mocks.exchangeGoogleOAuthCode,
}));

vi.mock("../../src/integrations/google/config", () => ({
  GOOGLE_OAUTH_DEFAULT_PRINCIPAL: "default",
  getGoogleOAuthConfig: mocks.getGoogleOAuthConfig,
}));

vi.mock("../../src/chat-adapters/telegram/api", () => ({
  sendTelegramTextMessage: mocks.sendTelegramTextMessage,
}));

import { handleGoogleOAuthCallback } from "../../src/integrations/google/callback";

describe("google callback", () => {
  beforeEach(() => {
    mocks.decodeEncryptionKey.mockReset();
    mocks.encryptSecret.mockReset();
    mocks.getGoogleOAuthState.mockReset();
    mocks.markGoogleOAuthStateUsed.mockReset();
    mocks.upsertGoogleOAuthToken.mockReset();
    mocks.exchangeGoogleOAuthCode.mockReset();
    mocks.getGoogleOAuthConfig.mockReset();
    mocks.sendTelegramTextMessage.mockReset();
  });

  it("returns an html error when state or code is missing", async () => {
    const { env } = createEnv();
    const response = await handleGoogleOAuthCallback(
      new Request("https://test.local/google/oauth/callback?state="),
      env,
    );

    expect(response.status).toBe(400);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await response.text()).toContain("Missing state or code.");
  });

  it("stores the refresh token and notifies Telegram on success", async () => {
    const { env } = createEnv();
    mocks.getGoogleOAuthState.mockResolvedValue({
      chatId: 777,
      telegramUserId: 42,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      usedAt: null,
    });
    mocks.markGoogleOAuthStateUsed.mockResolvedValue(true);
    mocks.getGoogleOAuthConfig.mockReturnValue({
      clientId: "client-id",
      clientSecret: "secret",
      redirectUri: env.GOOGLE_OAUTH_REDIRECT_URI,
    });
    mocks.exchangeGoogleOAuthCode.mockResolvedValue({
      accessToken: "access-token",
      refreshToken: "refresh-token",
      scope: "scope-a scope-b",
      expiresIn: 3600,
      tokenType: "Bearer",
    });
    mocks.decodeEncryptionKey.mockReturnValue(new Uint8Array(32));
    mocks.encryptSecret.mockResolvedValue({ ciphertext: "ciphertext", nonce: "nonce" });
    mocks.sendTelegramTextMessage.mockResolvedValue(undefined);

    const response = await handleGoogleOAuthCallback(
      new Request("https://test.local/google/oauth/callback?state=test-state&code=test-code"),
      env,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Google OAuth complete");
    expect(mocks.markGoogleOAuthStateUsed).toHaveBeenCalledWith(
      env.DRECLAW_DB,
      "test-state",
      expect.any(String),
    );
    expect(mocks.upsertGoogleOAuthToken).toHaveBeenCalledWith(env.DRECLAW_DB, {
      principal: "default",
      telegramUserId: 42,
      refreshTokenCiphertext: "ciphertext",
      nonce: "nonce",
      scopes: "scope-a scope-b",
      updatedAt: expect.any(String),
    });
    expect(mocks.sendTelegramTextMessage).toHaveBeenCalledWith(
      env.TELEGRAM_BOT_TOKEN,
      777,
      "Google account linked successfully. You can now use Google features.",
    );
  });

  it("returns an expired-link response before exchanging the code", async () => {
    const { env } = createEnv();
    mocks.getGoogleOAuthState.mockResolvedValue({
      chatId: 777,
      telegramUserId: 42,
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
      usedAt: null,
    });

    const response = await handleGoogleOAuthCallback(
      new Request("https://test.local/google/oauth/callback?state=test-state&code=test-code"),
      env,
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toContain(
      "Authorization link expired. Run /google connect again.",
    );
    expect(mocks.markGoogleOAuthStateUsed).not.toHaveBeenCalled();
    expect(mocks.exchangeGoogleOAuthCode).not.toHaveBeenCalled();
  });
});
