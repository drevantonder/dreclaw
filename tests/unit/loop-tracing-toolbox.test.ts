import { describe, expect, it } from "vite-plus/test";
import { patchVfsContent } from "../../src/core/loop/toolbox";
import {
  redactSensitiveText,
  renderToolTranscript,
  truncateForLog,
} from "../../src/core/loop/tracing";

describe("loop tracing and toolbox helpers", () => {
  it("redacts sensitive values in transcripts", () => {
    const transcript = renderToolTranscript({
      name: "bash",
      args: { command: "echo test", token: "secret-token" },
      ok: true,
      output: "authorization=Bearer abc123",
    });

    expect(transcript).toContain("[REDACTED]");
    expect(redactSensitiveText("api_key=shh")).toContain("[REDACTED]");
    expect(truncateForLog("a\nb\nc", 4)).toBe("a b...");
  });

  it("patches VFS content and rejects ambiguous replacements", () => {
    expect(patchVfsContent("hello world", "world", "dreclaw", false)).toEqual({
      content: "hello dreclaw",
      replacements: 1,
    });
    expect(() => patchVfsContent("x x", "x", "y", false)).toThrow("PATCH_AMBIGUOUS");
    expect(() => patchVfsContent("x", "", "y", false)).toThrow("PATCH_INVALID");
  });
});
