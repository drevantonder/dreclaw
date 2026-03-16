import { describe, expect, it } from "vite-plus/test";
import {
  inferImplicitSkillNames,
  normalizeProactiveMessage,
  renderTaskGuidance,
  shouldEnableAgentTools,
  shouldIncludeMemoryContext,
} from "../../src/core/loop/prompting";

describe("loop prompting", () => {
  it("enables tools for concrete task-style requests", () => {
    expect(shouldEnableAgentTools("List my Google calendar events")).toBe(true);
    expect(shouldEnableAgentTools("hi")).toBe(false);
  });

  it("includes memory context for memory-oriented prompts", () => {
    expect(shouldIncludeMemoryContext("What did we discuss earlier about the launch?")).toBe(true);
    expect(shouldIncludeMemoryContext("ok")).toBe(false);
  });

  it("infers builtin skills from the prompt text", () => {
    expect(inferImplicitSkillNames("Check my Gmail and save a helper file")).toEqual([
      "google",
      "execute-runtime",
      "vfs",
    ]);
  });

  it("renders task guidance and suppresses proactive NO_MESSAGE replies", () => {
    expect(renderTaskGuidance("Use bash and grep to inspect logs")).toContain("Prefer bash");
    expect(normalizeProactiveMessage("NO_MESSAGE")).toBe(null);
    expect(normalizeProactiveMessage("  Follow up now.  ")).toBe("Follow up now.");
  });
});
