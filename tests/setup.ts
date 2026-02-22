import { vi } from "vitest";

interface MockSandboxState {
  files: Map<string, string>;
}

const sandboxes = new Map<string, MockSandboxState>();

vi.mock("@cloudflare/sandbox", () => {
  function getState(name: string): MockSandboxState {
    let state = sandboxes.get(name);
    if (!state) {
      state = { files: new Map() };
      sandboxes.set(name, state);
    }
    return state;
  }

  return {
    Sandbox: class {},
    proxyToSandbox: vi.fn(async () => null),
    getSandbox: vi.fn((_namespace: unknown, name: string) => {
      const state = getState(name);
      return {
        exec: async (cmd: string) => {
          if (cmd.includes("pi-ai login openai-codex") || cmd.includes("pi-ai openai-codex")) {
            state.files.set("/root/dreclaw/.pi-ai/auth.json", JSON.stringify({ provider: "openai-codex" }));
            return { success: true, stdout: "pi-ai login success", stderr: "", exitCode: 0 };
          }
          return { success: true, stdout: `ran: ${cmd}`, stderr: "", exitCode: 0 };
        },
        readFile: async (path: string) => {
          const content = state.files.get(path);
          if (content === undefined) throw new Error("ENOENT");
          return { content };
        },
      };
    }),
  };
});
