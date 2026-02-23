import { describe, expect, it, vi } from "vitest";
import { getOAuthApiKey, normalizeImportedCredential } from "../../src/oauth";

describe("oauth", () => {
  it("normalizes imported credential", () => {
    const credential = normalizeImportedCredential({
      provider: "openai-codex",
      access_token: "abc",
      refresh_token: "def",
      expires_in: 120,
    });

    expect(credential.provider).toBe("openai-codex");
    expect(credential.accessToken).toBe("abc");
    expect(credential.refreshToken).toBe("def");
    expect(credential.expiresAt).toBeTruthy();
  });

  it("returns access token without refresh when valid", async () => {
    const api = await getOAuthApiKey("openai-codex", {
      "openai-codex": { provider: "openai-codex", accessToken: "tok", expiresAt: "2999-01-01T00:00:00.000Z" },
    });
    expect(api.apiKey).toBe("tok");
  });

  it("refreshes token when expired", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ access_token: "newtok", refresh_token: "newref", expires_in: 3600 }), { status: 200 }),
      ),
    );

    const api = await getOAuthApiKey("openai-codex", {
      "openai-codex": {
        provider: "openai-codex",
        accessToken: "old",
        refreshToken: "ref",
        expiresAt: "2000-01-01T00:00:00.000Z",
        tokenEndpoint: "https://oauth.test/token",
        clientId: "cid",
      },
    });

    expect(api.apiKey).toBe("newtok");
    expect(api.updated?.refreshToken).toBe("newref");
  });
});
