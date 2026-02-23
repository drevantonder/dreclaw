import { describe, expect, it } from "vitest";
import { R2FilesystemService } from "../../src/filesystem";
import { extractToolCall, runTool, SessionShell } from "../../src/tools";
import { FakeR2 } from "../helpers/fakes";

describe("tools", () => {
  it("extracts json tool call", async () => {
    const tool = extractToolCall('{"tool":{"name":"write","args":{"path":"a.txt"}}}');
    expect(tool?.name).toBe("write");
    expect(tool?.args.path).toBe("a.txt");
  });

  it("runs write/read/edit/bash flow over persisted fs", async () => {
    const bucket = new FakeR2();
    const fs = new R2FilesystemService(bucket as unknown as R2Bucket, "session-1");
    const shell = new SessionShell(fs);

    expect((await runTool({ name: "write", args: { path: "a.txt", content: "hello" } }, { shell })).ok).toBe(true);
    expect((await runTool({ name: "read", args: { path: "a.txt" } }, { shell })).output).toBe("hello");
    expect((await runTool({ name: "edit", args: { path: "a.txt", find: "hell", replace: "yell" } }, { shell })).ok).toBe(true);
    expect((await runTool({ name: "read", args: { path: "a.txt" } }, { shell })).output).toBe("yello");

    const command = await runTool({ name: "bash", args: { command: "cat a.txt" } }, { shell });
    expect(command.ok).toBe(true);
    expect(command.output.trim()).toBe("yello");

    const restoredShell = new SessionShell(fs);
    expect((await runTool({ name: "read", args: { path: "a.txt" } }, { shell: restoredShell })).output).toBe("yello");
  });
});
