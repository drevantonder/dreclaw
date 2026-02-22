import { describe, expect, it } from "vitest";
import { extractToolCall, runToolInSandbox } from "../../src/tools";

function makeSandbox() {
  const files = new Map<string, string>();

  return {
    files,
    client: {
      readFile: async (path: string) => {
        const value = files.get(path);
        if (value === undefined) throw new Error("ENOENT");
        return { content: value };
      },
      writeFile: async (path: string, content: string) => {
        files.set(path, content);
        return { success: true };
      },
      exec: async (command: string) => ({
        success: true,
        stdout: `ok:${command}`,
        stderr: "",
        exitCode: 0,
      }),
    },
  };
}

describe("tools", () => {
  it("extracts json tool call", () => {
    const tool = extractToolCall('{"tool":{"name":"write","args":{"path":"a.txt"}}}');
    expect(tool?.name).toBe("write");
    expect(tool?.args.path).toBe("a.txt");
  });

  it("runs write/read/edit flow in sandbox", async () => {
    const sandbox = makeSandbox();
    expect((await runToolInSandbox({ name: "write", args: { path: "a.txt", content: "hello" } }, sandbox.client as never)).ok).toBe(true);
    expect((await runToolInSandbox({ name: "read", args: { path: "a.txt" } }, sandbox.client as never)).output).toBe("hello");
    expect((await runToolInSandbox({ name: "edit", args: { path: "a.txt", find: "hell", replace: "yell" } }, sandbox.client as never)).ok).toBe(true);
    expect((await runToolInSandbox({ name: "read", args: { path: "a.txt" } }, sandbox.client as never)).output).toBe("yello");
  });
});
