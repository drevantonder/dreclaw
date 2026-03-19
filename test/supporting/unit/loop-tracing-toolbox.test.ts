import { describe, expect, it } from "vite-plus/test";
import {
  redactSensitiveText,
  renderTraceStart,
  renderToolTranscript,
  truncateForLog,
} from "../../../src/core/runtime/tools/tracing";

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

  it("renders codemode traces with a code block", () => {
    const trace = renderTraceStart("codemode", {
      code: 'async () => {\n  return "ok";\n}',
    });

    expect(trace).toContain("Tool: codemode");
    expect(trace).toContain("```js");
    expect(trace).toContain('return "ok"');
  });
});
