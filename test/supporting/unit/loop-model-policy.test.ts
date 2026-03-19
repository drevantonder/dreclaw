import { describe, expect, it } from "vite-plus/test";
import {
  getAgentProviderOptions,
  getMaxOutputTokens,
  getRunSliceSteps,
  getRunTimeoutMs,
  getRuntimeConfig,
  getTypingPulseMs,
} from "../../../src/core/runtime/policy/model";
import { createEnv } from "../../helpers/fakes";

describe("loop model policy", () => {
  it("builds workers runtime config for Workers AI Kimi", () => {
    const { env } = createEnv({
      AI_PROVIDER: "workers",
      MODEL: "@cf/zai-org/glm-4.7-flash",
    });

    const runtime = getRuntimeConfig(env as never, { modelAlias: "workers-kimi" });

    expect(runtime.provider).toBe("workers");
    expect(runtime.model).toBe("@cf/moonshotai/kimi-k2.5");
  });

  it("builds non-worker runtime config with provider defaults", () => {
    const { env } = createEnv({
      AI_PROVIDER: "fireworks",
      MODEL: "accounts/fireworks/models/kimi-k2p5",
      FIREWORKS_API_KEY: "fw-key",
      FIREWORKS_BASE_URL: undefined,
    });

    const runtime = getRuntimeConfig(env as never, { modelAlias: "fireworks-kimi" });

    expect(runtime.provider).toBe("fireworks");
    if (runtime.provider === "workers") throw new Error("expected fireworks runtime");
    expect(runtime.baseUrl).toContain("fireworks");
    expect(getAgentProviderOptions(runtime, undefined)?.fireworks?.reasoningEffort).toBe("none");
    expect(getMaxOutputTokens(runtime, "conversation")).toBe(192);
  });

  it("uses parsing guards for runtime heuristics", () => {
    expect(getRunTimeoutMs("Summarize my Gmail inbox")).toBe(45_000);
    expect(getRunTimeoutMs("hello")).toBe(40_000);
    expect(getRunSliceSteps("30")).toBe(12);
    expect(getRunSliceSteps("bad")).toBe(4);
    expect(getTypingPulseMs("300")).toBe(2500);
    expect(getTypingPulseMs("1500")).toBe(1500);
  });
});
