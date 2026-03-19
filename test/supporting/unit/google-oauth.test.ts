import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
  buildGoogleOAuthUrl,
  createOAuthStateToken,
  exchangeGoogleOAuthCode,
  getGoogleOAuthConfig,
  parseGoogleScopes,
  refreshGoogleAccessToken,
} from "../../../src/plugins/google/testing";
import type { Env } from "../../../src/cloudflare/env";

afterEach(() => {
  vi.restoreAllMocks();
});

function createEnv(overrides?: Partial<Env>): Env {
  return {
    TELEGRAM_BOT_TOKEN: "token",
    TELEGRAM_WEBHOOK_SECRET: "secret",
    TELEGRAM_ALLOWED_USER_ID: "42",
    MODEL: "model",
    DRECLAW_DB: {} as D1Database,
    CONVERSATION_WORKFLOW: {} as Env["CONVERSATION_WORKFLOW"],
    GOOGLE_OAUTH_CLIENT_ID: "client-id",
    GOOGLE_OAUTH_CLIENT_SECRET: "client-secret",
    GOOGLE_OAUTH_REDIRECT_URI: "https://worker.example.com/google/oauth/callback",
    GOOGLE_OAUTH_SCOPES: "scopeA scopeB",
    ...overrides,
  };
}

describe("google-oauth", () => {
  it("loads config from env", () => {
    const config = getGoogleOAuthConfig(createEnv());
    expect(config.clientId).toBe("client-id");
    expect(config.scopes).toEqual(["scopeA", "scopeB"]);
  });

  it("builds auth url with oauth params", () => {
    const config = getGoogleOAuthConfig(createEnv());
    const url = new URL(buildGoogleOAuthUrl(config, "state-1"));
    expect(url.hostname).toBe("accounts.google.com");
    expect(url.searchParams.get("state")).toBe("state-1");
    expect(url.searchParams.get("scope")).toBe("scopeA scopeB");
    expect(url.searchParams.get("access_type")).toBe("offline");
  });

  it("creates random state token", () => {
    const a = createOAuthStateToken();
    const b = createOAuthStateToken();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(20);
  });

  it("exchanges auth code for tokens", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              access_token: "access",
              refresh_token: "refresh",
              scope: "scopeA scopeB",
              expires_in: 3600,
              token_type: "Bearer",
            }),
            { status: 200 },
          ),
      ),
    );
    const config = getGoogleOAuthConfig(createEnv());
    const result = await exchangeGoogleOAuthCode(config, "code-1");
    expect(result.accessToken).toBe("access");
    expect(result.refreshToken).toBe("refresh");
  });

  it("refreshes access token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              access_token: "access-2",
              scope: "scopeA scopeB",
              expires_in: 3500,
              token_type: "Bearer",
            }),
            { status: 200 },
          ),
      ),
    );
    const config = getGoogleOAuthConfig(createEnv());
    const result = await refreshGoogleAccessToken(config, "refresh");
    expect(result.accessToken).toBe("access-2");
  });

  it("fails on token endpoint error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })),
    );
    const config = getGoogleOAuthConfig(createEnv());
    await expect(exchangeGoogleOAuthCode(config, "bad")).rejects.toThrow("invalid_grant");
  });

  it("parses default scopes when omitted", () => {
    const scopes = parseGoogleScopes(undefined);
    expect(scopes.length).toBeGreaterThanOrEqual(3);
  });
});
