import { describe, expect, it } from "vite-plus/test";
import { getMemoryConfig } from "../../src/core/memory/config";
import type { Env } from "../../src/cloudflare/env";

function baseEnv(overrides: Partial<Env> = {}): Env {
  return {
    TELEGRAM_BOT_TOKEN: "x",
    TELEGRAM_WEBHOOK_SECRET: "x",
    TELEGRAM_ALLOWED_USER_ID: "1",
    MODEL: "m",
    DRECLAW_DB: {} as D1Database,
    CONVERSATION_WORKFLOW: {} as Env["CONVERSATION_WORKFLOW"],
    ...overrides,
  };
}

describe("memory config", () => {
  it("allows disabled memory without AI/vectorize bindings", () => {
    const config = getMemoryConfig(baseEnv({ MEMORY_ENABLED: "false" }));
    expect(config.enabled).toBe(false);
  });

  it("requires AI and vectorize when enabled", () => {
    expect(() => getMemoryConfig(baseEnv({ MEMORY_ENABLED: "true" }))).toThrow(
      /requires AI binding/,
    );
  });
});
