import { vi } from "vitest";

interface MockSandboxState {
  files: Map<string, string>;
  mounted: boolean;
}

const sandboxes = new Map<string, MockSandboxState>();

vi.mock("@cloudflare/sandbox", () => {
  function getState(name: string): MockSandboxState {
    let state = sandboxes.get(name);
    if (!state) {
      state = { files: new Map(), mounted: false };
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
          if (cmd.includes("pi-ai chat") || cmd.includes("pi-ai --model") || /\bpi-ai\b/.test(cmd)) {
            const prompt = state.files.get("/tmp/dreclaw_prompt.txt") ?? "";
            if (prompt.includes("52 * 100")) {
              return { success: true, stdout: "5200", stderr: "", exitCode: 0 };
            }
            if (prompt.includes("/root/dreclaw")) {
              return {
                success: true,
                stdout: '{"tool":{"name":"bash","args":{"command":"pwd"}}}',
                stderr: "",
                exitCode: 0,
              };
            }
            return { success: true, stdout: "hello from model", stderr: "", exitCode: 0 };
          }
          return { success: true, stdout: `ran: ${cmd}`, stderr: "", exitCode: 0 };
        },
        readFile: async (path: string) => {
          const content = state.files.get(path);
          if (content === undefined) throw new Error("ENOENT");
          return { content };
        },
        writeFile: async (path: string, content: string) => {
          state.files.set(path, content);
          return { success: true };
        },
        exists: async (path: string) => {
          return { exists: state.files.has(path) };
        },
        mountBucket: async () => {
          state.mounted = true;
        },
      };
    }),
  };
});
