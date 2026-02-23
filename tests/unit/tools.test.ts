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

  it("flushes only changed files when persistence is deferred", async () => {
    const bucket = new FakeR2();
    const fs = new R2FilesystemService(bucket as unknown as R2Bucket, "session-2");
    const shell = new SessionShell(fs);

    await runTool({ name: "write", args: { path: "a.txt", content: "one" } }, { shell, deferPersistence: true });
    await runTool({ name: "write", args: { path: "b.txt", content: "two" } }, { shell, deferPersistence: true });
    expect(bucket.counters.put).toBe(0);

    await shell.flush();
    expect(bucket.counters.put).toBe(2);

    await runTool({ name: "edit", args: { path: "a.txt", find: "one", replace: "uno" } }, { shell, deferPersistence: true });
    await shell.flush();
    expect(bucket.counters.put).toBe(3);
    expect(bucket.counters.list).toBe(1);

    const restoredShell = new SessionShell(fs);
    expect((await runTool({ name: "read", args: { path: "a.txt" } }, { shell: restoredShell })).output).toBe("uno");
    expect((await runTool({ name: "read", args: { path: "b.txt" } }, { shell: restoredShell })).output).toBe("two");
  });

  it("persists deletions from bash on flush", async () => {
    const bucket = new FakeR2();
    const fs = new R2FilesystemService(bucket as unknown as R2Bucket, "session-3");
    const shell = new SessionShell(fs);

    await runTool({ name: "write", args: { path: "a.txt", content: "A" } }, { shell, deferPersistence: true });
    await runTool({ name: "write", args: { path: "b.txt", content: "B" } }, { shell, deferPersistence: true });
    await shell.flush();

    const bashResult = await runTool({ name: "bash", args: { command: "rm b.txt" } }, { shell, deferPersistence: true });
    expect(bashResult.ok).toBe(true);
    await shell.flush();

    const restoredShell = new SessionShell(fs);
    expect((await runTool({ name: "read", args: { path: "a.txt" } }, { shell: restoredShell })).ok).toBe(true);
    const missing = await runTool({ name: "read", args: { path: "b.txt" } }, { shell: restoredShell });
    expect(missing.ok).toBe(false);
    expect(bucket.counters.delete).toBeGreaterThan(0);
  });
});
