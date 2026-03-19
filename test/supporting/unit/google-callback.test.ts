import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createEnv } from "../../helpers/fakes";

const mocks = vi.hoisted(() => ({
  decodeEncryptionKey: vi.fn(),
  encryptSecret: vi.fn(),
  getGoogleOAuthState: vi.fn(),
  markGoogleOAuthStateUsed: vi.fn(),
  upsertGoogleOAuthToken: vi.fn(),
  exchangeGoogleOAuthCode: vi.fn(),
  getGoogleOAuthConfig: vi.fn(),
}));

vi.mock("../../../src/plugins/google/crypto", () => ({
  decodeEncryptionKey: mocks.decodeEncryptionKey,
  encryptSecret: mocks.encryptSecret,
}));

vi.mock("../../../src/plugins/google/repo", () => ({
  getGoogleOAuthState: mocks.getGoogleOAuthState,
  markGoogleOAuthStateUsed: mocks.markGoogleOAuthStateUsed,
  upsertGoogleOAuthToken: mocks.upsertGoogleOAuthToken,
}));

vi.mock("../../../src/plugins/google/oauth", () => ({
  exchangeGoogleOAuthCode: mocks.exchangeGoogleOAuthCode,
}));

vi.mock("../../../src/plugins/google/config", () => ({
  GOOGLE_OAUTH_DEFAULT_PRINCIPAL: "default",
  getGoogleOAuthConfig: mocks.getGoogleOAuthConfig,
}));

import { handleGoogleOAuthCallback } from "../../../src/plugins/google/testing";

describe("google callback", () => {
  beforeEach(() => {
    mocks.decodeEncryptionKey.mockReset();
    mocks.encryptSecret.mockReset();
    mocks.getGoogleOAuthState.mockReset();
    mocks.markGoogleOAuthStateUsed.mockReset();
    mocks.upsertGoogleOAuthToken.mockReset();
    mocks.exchangeGoogleOAuthCode.mockReset();
    mocks.getGoogleOAuthConfig.mockReset();
  });

  it("returns a failure result when state or code is missing", async () => {
    const { env } = createEnv();
    const result = await handleGoogleOAuthCallback(
      new Request("https://test.local/google/oauth/callback?state="),
      env,
    );

    expect(result).toEqual({
      status: 400,
      title: "Google OAuth failed",
      body: "Missing state or code.",
    });
  });

  it("stores the refresh token and returns a notification payload on success", async () => {
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

    const result = await handleGoogleOAuthCallback(
      new Request("https://test.local/google/oauth/callback?state=test-state&code=test-code"),
      env,
    );

    expect(result).toEqual({
      status: 200,
      title: "Google OAuth complete",
      body: "You can close this tab and return to Telegram.",
      effects: [
        {
          type: "send-text",
          target: { channel: "telegram", id: "777" },
          text: "Google account linked successfully. You can now use Google features.",
        },
      ],
    });
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
  });

  it("returns an expired-link result before exchanging the code", async () => {
    const { env } = createEnv();
    mocks.getGoogleOAuthState.mockResolvedValue({
      chatId: 777,
      telegramUserId: 42,
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
      usedAt: null,
    });

    const result = await handleGoogleOAuthCallback(
      new Request("https://test.local/google/oauth/callback?state=test-state&code=test-code"),
      env,
    );

    expect(result).toEqual({
      status: 400,
      title: "Google OAuth failed",
      body: "Authorization link expired. Run /google connect again.",
    });
    expect(mocks.markGoogleOAuthStateUsed).not.toHaveBeenCalled();
    expect(mocks.exchangeGoogleOAuthCode).not.toHaveBeenCalled();
  });
});
