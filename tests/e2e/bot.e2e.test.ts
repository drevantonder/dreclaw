import { beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../../src/index";
import { createEnv } from "../helpers/fakes";

const app = worker as unknown as {
  fetch(request: Request, env: unknown, ctx: ExecutionContext): Promise<Response>;
};

const testCtx = {
  waitUntil: (_task: Promise<unknown>) => undefined,
  passThroughOnException: () => undefined,
  props: {},
} as unknown as ExecutionContext;

function createExecutionTracker() {
  const pending: Promise<unknown>[] = [];
  return {
    ctx: {
      waitUntil(task: Promise<unknown>) {
        pending.push(task);
      },
      passThroughOnException() {
        return;
      },
      props: {},
    } as unknown as ExecutionContext,
    async wait() {
      await Promise.allSettled(pending.splice(0));
    },
  };
}

function telegramMessageResult(text: string, messageId: number) {
  return {
    ok: true,
    result: {
      message_id: messageId,
      date: 170000,
      text,
      chat: { id: 777, type: "private" },
      from: { id: 999, is_bot: true, username: "dreclawbot", first_name: "dreclaw" },
    },
  };
}

type MockContext = {
  messages?: Array<Record<string, unknown>>;
  tools: Array<{ name: string; execute: (toolCallId: string, params: unknown) => Promise<unknown> }>;
};

type MockAssistant = {
  stopReason: "endTurn" | "toolUse";
  content: Array<Record<string, unknown>>;
};

const { modelQueue } = vi.hoisted(() => ({ modelQueue: [] as MockAssistant[] }));

vi.mock("@ai-sdk/openai-compatible", () => ({
  createOpenAICompatible: () => (_modelId: string) => ({ id: "mock-model" }),
}));

vi.mock("../../src/code-exec", () => ({
  executeCode: vi.fn(async (_input: { code: string }, ctx: { vfs?: { writeFile: (path: string, content: string, overwrite: boolean) => Promise<unknown> } }) => {
    await ctx.vfs?.writeFile("/tmp/output.txt", "hello", true);
    return { ok: true, result: "done", logs: [], stats: {} };
  }),
  getCodeExecutionConfig: vi.fn(() => ({
    codeExecEnabled: true,
    netFetchEnabled: true,
    pkgInstallEnabled: true,
    limits: {
      execTimeoutMs: 1000,
      execMemoryMb: 32,
      execStackKb: 512,
      execMaxHostCalls: 10,
      execMaxLogLines: 10,
      execMaxOutputBytes: 10000,
      netMaxRequestsPerRun: 10,
      netMaxParallel: 2,
      netRequestTimeoutMs: 1000,
      netMaxResponseBytes: 10000,
      netMaxTotalDownloadBytes: 10000,
      netMaxRedirects: 2,
      pkgInstallTimeoutMs: 1000,
      pkgMaxSpecLength: 100,
      pkgMaxModuleBytes: 10000,
      pkgMaxTotalInstallBytesPerRun: 10000,
      pkgMaxInstallsPerRun: 2,
      vfsMaxFileBytes: 10000,
      vfsMaxFiles: 100,
      vfsMaxPathLength: 255,
      vfsListLimit: 100,
    },
  })),
  normalizeCodeRuntimeState: vi.fn((state?: { installedPackages?: unknown[] }) => ({ installedPackages: state?.installedPackages ?? [] })),
  searchCodeRuntime: vi.fn(({ query }: { query?: string }) => ({ runtime: { engine: "quickjs-emscripten", apis: [], limits: {} }, packages: query ? [{ spec: query }] : [] })),
}));

vi.mock("ai", () => {
  class MockToolLoopAgent {
    private readonly tools: Record<string, { execute?: (args: unknown) => Promise<unknown> }>;

    constructor(options?: { tools?: Record<string, { execute?: (args: unknown) => Promise<unknown> }> }) {
      this.tools = options?.tools ?? {};
    }

    private async run(_options: { messages?: Array<Record<string, unknown>> }) {
      const messages: Array<Record<string, unknown>> = [];
      while (true) {
        const context: MockContext = {
          messages,
          tools: Object.entries(this.tools).map(([name, entry]) => ({
            name,
            execute: async (_toolCallId: string, params: unknown) => entry.execute?.(params),
          })),
        };

        const next = modelQueue.shift();
        if (!next) throw new Error("Missing mocked model response");

        const textBlocks = next.content.filter((block) => block.type === "text");
        const toolCalls = next.content.filter((block) => block.type === "toolCall");
        for (const toolCall of toolCalls) {
          const tool = context.tools.find((entry) => entry.name === toolCall.name);
          await tool?.execute(String(toolCall.id ?? ""), toolCall.arguments ?? {});
        }

        const text = textBlocks.map((block) => String(block.text ?? "")).join("\n").trim();
        messages.push({ role: "assistant", content: text });

        if (next.stopReason === "toolUse") continue;
        return { text, response: { messages } };
      }
    }

    async stream(options: { messages?: Array<Record<string, unknown>> }) {
      const runPromise = this.run(options);
      return {
        textStream: (async function* () {
          const result = await runPromise;
          if (result.text) yield result.text;
        })(),
        text: runPromise.then((result) => result.text),
        response: runPromise.then((result) => result.response),
      };
    }
  }

  return {
    ToolLoopAgent: MockToolLoopAgent,
    stepCountIs: (count: number) => ({ count }),
    tool: <T>(value: T) => value,
  };
});

function makeUpdate(updateId: number, text?: string) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 170000,
      chat: { id: 777, type: "private" },
      from: { id: 42, is_bot: false, username: "andre", first_name: "Andre" },
      ...(text !== undefined ? { text } : {}),
    },
  };
}

function makeWebhookRequest(secret: string, updateId: number, text?: string) {
  return new Request("https://test.local/telegram/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": secret,
    },
    body: JSON.stringify(makeUpdate(updateId, text)),
  });
}

describe("chat sdk bot", () => {
  beforeEach(() => {
    modelQueue.length = 0;
  });

  it("streams a normal reply and dedupes duplicate webhook deliveries", async () => {
    const { env } = createEnv();
    const sent: string[] = [];
    const edited: string[] = [];
    const tracker = createExecutionTracker();

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/getMe")) {
          return new Response(JSON.stringify({ ok: true, result: { id: 999, is_bot: true, username: "dreclawbot" } }), { status: 200 });
        }
        if (url.includes("/getWebhookInfo")) {
          return new Response(JSON.stringify({ ok: true, result: { url: "https://test.local/telegram/webhook" } }), { status: 200 });
        }
        if (url.includes("/sendChatAction")) {
          return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
        }
        if (url.includes("/sendMessage")) {
          const body = JSON.parse(String(init?.body ?? "{}")) as { text?: string };
          sent.push(body.text ?? "");
          return new Response(JSON.stringify(telegramMessageResult(body.text ?? "", 100)), { status: 200 });
        }
        if (url.includes("/editMessageText")) {
          const body = JSON.parse(String(init?.body ?? "{}")) as { text?: string };
          edited.push(body.text ?? "");
          return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }),
    );

    modelQueue.push({ stopReason: "endTurn", content: [{ type: "text", text: "Hello from Chat SDK." }] });

    const first = await app.fetch(makeWebhookRequest(env.TELEGRAM_WEBHOOK_SECRET, 1, "hello") as unknown as Request, env, tracker.ctx);
    await tracker.wait();
    expect(first.status).toBe(200);
    expect([...sent, ...edited].join("\n")).toContain("Hello from Chat SDK.");

    const second = await app.fetch(makeWebhookRequest(env.TELEGRAM_WEBHOOK_SECRET, 1, "hello") as unknown as Request, env, tracker.ctx);
    await tracker.wait();
    expect(second.status).toBe(200);
    expect([...sent, ...edited].join("\n").match(/Hello from Chat SDK\./g)?.length).toBe(1);
  });

  it("supports /verbose and emits execute traces with code, writes, and result", async () => {
    const { env } = createEnv();
    const sent: string[] = [];
    const edited: string[] = [];
    const tracker = createExecutionTracker();

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/getMe")) {
          return new Response(JSON.stringify({ ok: true, result: { id: 999, is_bot: true, username: "dreclawbot" } }), { status: 200 });
        }
        if (url.includes("/getWebhookInfo")) {
          return new Response(JSON.stringify({ ok: true, result: { url: "https://test.local/telegram/webhook" } }), { status: 200 });
        }
        if (url.includes("/sendChatAction")) {
          return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
        }
        if (url.includes("/sendMessage")) {
          const body = JSON.parse(String(init?.body ?? "{}")) as { text?: string };
          sent.push(body.text ?? "");
          return new Response(JSON.stringify(telegramMessageResult(body.text ?? "", sent.length + 100)), { status: 200 });
        }
        if (url.includes("/editMessageText")) {
          const body = JSON.parse(String(init?.body ?? "{}")) as { text?: string };
          edited.push(body.text ?? "");
          return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }),
    );

    const headers = {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": env.TELEGRAM_WEBHOOK_SECRET,
    };

    await app.fetch(
      new Request("https://test.local/telegram/webhook", {
        method: "POST",
        headers,
        body: JSON.stringify(makeUpdate(2, "/verbose on")),
      }) as unknown as Request,
      env,
      tracker.ctx,
    );
    await tracker.wait();

    modelQueue.push(
      {
        stopReason: "toolUse",
        content: [
          { type: "toolCall", id: "tool-1", name: "execute", arguments: { code: 'await fs.write("/tmp/output.txt", "hello")' } },
        ],
      },
      { stopReason: "endTurn", content: [{ type: "text", text: "Done running code." }] },
    );

    await app.fetch(
      new Request("https://test.local/telegram/webhook", {
        method: "POST",
        headers,
        body: JSON.stringify(makeUpdate(3, "run code")),
      }) as unknown as Request,
      env,
      tracker.ctx,
    );
    await tracker.wait();

    const output = [...sent, ...edited].join("\n");
    expect(output).toContain("verbose enabled");
    expect(output).toContain("Tool: execute");
    expect(output).toContain("await fs.write");
    expect(output).toContain("writes: write /tmp/output.txt");
    expect(output).toContain("result: {\"ok\":true");
    expect(output).toContain("Done running code.");
  });

  it("handles status and google connect commands", async () => {
    const { env, db } = createEnv();
    const sent: string[] = [];
    const tracker = createExecutionTracker();

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/getMe")) {
          return new Response(JSON.stringify({ ok: true, result: { id: 999, is_bot: true, username: "dreclawbot" } }), { status: 200 });
        }
        if (url.includes("/getWebhookInfo")) {
          return new Response(JSON.stringify({ ok: true, result: { url: "https://test.local/telegram/webhook" } }), { status: 200 });
        }
        if (url.includes("/sendChatAction")) {
          return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
        }
        if (url.includes("/sendMessage")) {
          const body = JSON.parse(String(init?.body ?? "{}")) as { text?: string };
          sent.push(body.text ?? "");
          return new Response(JSON.stringify(telegramMessageResult(body.text ?? "", 100)), { status: 200 });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }),
    );

    const headers = {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": env.TELEGRAM_WEBHOOK_SECRET,
    };

    await app.fetch(
      new Request("https://test.local/telegram/webhook", {
        method: "POST",
        headers,
        body: JSON.stringify(makeUpdate(4, "/status")),
      }) as unknown as Request,
      env,
      tracker.ctx,
    );
    await tracker.wait();
    await app.fetch(
      new Request("https://test.local/telegram/webhook", {
        method: "POST",
        headers,
        body: JSON.stringify(makeUpdate(5, "/google connect")),
      }) as unknown as Request,
      env,
      tracker.ctx,
    );
    await tracker.wait();

    const output = sent.join("\n");
    expect(output).toContain("model: test-model");
    expect(output).toContain("google: not linked");
    expect(output).toContain("Open this URL to connect Google:");
    expect(db.oauthStates.size).toBe(1);
  });
});
