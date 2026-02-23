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
