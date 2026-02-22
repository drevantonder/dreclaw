import { describe, expect, it } from "vitest";
import { parseToolCall, runOwnerExec, runTool } from "../../src/tools";
import { Workspace } from "../../src/workspace";
import { FakeR2 } from "../helpers/fakes";

function makeWorkspace(sessionId = "s1") {
  return new Workspace(new FakeR2() as unknown as R2Bucket, sessionId);
}

describe("tools", () => {
  it("parses /tool json commands", () => {
    const tool = parseToolCall('/tool write {"path":"a.txt","content":"x"}');
    expect(tool?.name).toBe("write");
    expect(tool?.args.path).toBe("a.txt");
  });

  it("runs write/read/edit flow", () => {
    const workspace = makeWorkspace();
    expect(runTool({ name: "write", args: { path: "a.txt", content: "hello" } }, workspace).ok).toBe(true);
    expect(runTool({ name: "read", args: { path: "a.txt" } }, workspace).output).toBe("hello");
    expect(runTool({ name: "edit", args: { path: "a.txt", find: "hell", replace: "yell" } }, workspace).ok).toBe(true);
    expect(runTool({ name: "read", args: { path: "a.txt" } }, workspace).output).toBe("yello");
  });

  it("stores auth marker via /exec pi-ai login", () => {
    const workspace = makeWorkspace("s2");
    const result = runOwnerExec("pi-ai login openai-codex", workspace);
    expect(result.ok).toBe(true);
    expect(workspace.authReady()).toBe(true);
  });
});
