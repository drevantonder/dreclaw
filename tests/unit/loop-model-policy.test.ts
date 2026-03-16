import { describe, expect, it } from "vite-plus/test";
import {
  getAgentProviderOptions,
  getMaxOutputTokens,
  getRunSliceSteps,
  getRunTimeoutMs,
  getRuntimeConfig,
  getTypingPulseMs,
} from "../../src/core/loop/model-policy";
import { createEnv } from "../helpers/fakes";

describe("loop model policy", () => {
  it("builds non-worker runtime config with provider defaults", () => {
    const { env } = createEnv({
      AI_PROVIDER: "fireworks",
      MODEL: "accounts/fireworks/models/kimi-k2p5",
      FIREWORKS_API_KEY: "fw-key",
      FIREWORKS_BASE_URL: undefined,
    });

    const runtime = getRuntimeConfig(env as never);

    expect(runtime.provider).toBe("fireworks");
    if (runtime.provider === "workers") throw new Error("expected fireworks runtime");
    expect(runtime.baseUrl).toContain("fireworks");
    expect(getAgentProviderOptions(runtime, undefined)?.fireworks?.reasoningEffort).toBe("none");
    expect(getMaxOutputTokens(runtime, "conversation")).toBe(192);
  });

  it("uses parsing guards for runtime heuristics", () => {
    expect(getRunTimeoutMs("Summarize my Gmail inbox")).toBe(22_000);
    expect(getRunTimeoutMs("hello")).toBe(25_000);
    expect(getRunSliceSteps("30")).toBe(12);
    expect(getRunSliceSteps("bad")).toBe(4);
    expect(getTypingPulseMs("300")).toBe(2500);
    expect(getTypingPulseMs("1500")).toBe(1500);
  });
});
