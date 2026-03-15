import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createEnv } from "../helpers/fakes";

const mocks = vi.hoisted(() => ({
  getGoogleOAuthConfig: vi.fn(),
  createOAuthStateToken: vi.fn(),
  createGoogleOAuthState: vi.fn(),
  getGoogleOAuthToken: vi.fn(),
  deleteGoogleOAuthToken: vi.fn(),
}));

vi.mock("../../src/plugins/google/config", () => ({
  GOOGLE_OAUTH_DEFAULT_PRINCIPAL: "default",
  getGoogleOAuthConfig: mocks.getGoogleOAuthConfig,
}));
vi.mock("../../src/plugins/google/oauth", () => ({
  buildGoogleOAuthUrl: vi.fn((_config: unknown, state: string) => `https://auth.test/${state}`),
  createOAuthStateToken: mocks.createOAuthStateToken,
}));
vi.mock("../../src/plugins/google/repo", () => ({
  createGoogleOAuthState: mocks.createGoogleOAuthState,
  getGoogleOAuthToken: mocks.getGoogleOAuthToken,
  deleteGoogleOAuthToken: mocks.deleteGoogleOAuthToken,
}));

import { handleGoogleCommand } from "../../src/plugins/google/testing";

describe("google commands", () => {
  beforeEach(() => {
    mocks.getGoogleOAuthConfig.mockReset();
    mocks.createOAuthStateToken.mockReset();
    mocks.createGoogleOAuthState.mockReset();
    mocks.getGoogleOAuthToken.mockReset();
    mocks.deleteGoogleOAuthToken.mockReset();
  });

  it("creates a connect link and persists oauth state", async () => {
    const { env } = createEnv();
    mocks.getGoogleOAuthConfig.mockReturnValue({
      clientId: "id",
      clientSecret: "secret",
      redirectUri: "https://cb",
      scopes: ["scope"],
    });
    mocks.createOAuthStateToken.mockReturnValue("state-1");

    const result = await handleGoogleCommand(env, {
      text: "/google connect",
      chatId: 777,
      telegramUserId: 42,
    });

    expect(result).toContain("Open this URL to connect Google:");
    expect(result).toContain("https://auth.test/state-1");
    expect(mocks.createGoogleOAuthState).toHaveBeenCalledWith(
      env.DRECLAW_DB,
      expect.objectContaining({ state: "state-1", chatId: 777, telegramUserId: 42 }),
    );
  });

  it("renders linked status from stored token", async () => {
    const { env } = createEnv();
    mocks.getGoogleOAuthToken.mockResolvedValue({
      scopes: "scope-a scope-b",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    const result = await handleGoogleCommand(env, {
      text: "/google status",
      chatId: 777,
      telegramUserId: 42,
    });

    expect(result).toContain("google: linked");
    expect(result).toContain("scope-a scope-b");
  });

  it("disconnects the linked token", async () => {
    const { env } = createEnv();
    mocks.deleteGoogleOAuthToken.mockResolvedValue(true);

    const result = await handleGoogleCommand(env, {
      text: "/google disconnect",
      chatId: 777,
      telegramUserId: 42,
    });

    expect(result).toBe("Google account disconnected.");
    expect(mocks.deleteGoogleOAuthToken).toHaveBeenCalledWith(env.DRECLAW_DB, "default");
  });
});
