import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createEnv } from "../helpers/fakes";

const mocks = vi.hoisted(() => ({
  createGoogleModule: vi.fn(),
  handleOAuthCallback: vi.fn(),
}));

vi.mock("../../src/integrations/google", () => ({
  createGoogleModule: mocks.createGoogleModule,
}));

import { handleGoogleOAuthCallbackRequest } from "../../src/cloudflare/http/controllers/google-oauth-callback";

describe("handleGoogleOAuthCallbackRequest", () => {
  beforeEach(() => {
    mocks.createGoogleModule.mockReset();
    mocks.handleOAuthCallback.mockReset();
    mocks.createGoogleModule.mockReturnValue({
      handleOAuthCallback: mocks.handleOAuthCallback,
    });
  });

  it("delegates callback handling to the google module", async () => {
    const { env } = createEnv();
    const expected = new Response("ok", { status: 200 });
    mocks.handleOAuthCallback.mockResolvedValue(expected);
    const request = new Request(
      "https://test.local/google/oauth/callback?state=test-state&code=test-code",
    );

    const response = await handleGoogleOAuthCallbackRequest(request, env);

    expect(response).toBe(expected);
    expect(mocks.createGoogleModule).toHaveBeenCalledWith(env);
    expect(mocks.handleOAuthCallback).toHaveBeenCalledWith(request);
  });
});
