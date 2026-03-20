import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { buildRemindersPluginDeps } from "../../../src/app/deps";
import { createRunCoordinator } from "../../../src/core/loop/run";
import type { ToolTrace, ToolTracer } from "../../../src/core/runtime/tools/tracing";
import { createWorkspaceGateway } from "../../../src/core/runtime/adapters/workspace";
import { createAgentTools } from "../../../src/core/runtime/tools/toolbox";
import { createRemindersPlugin } from "../../../src/plugins/reminders";
import type { MemoryGateway } from "../../../src/core/runtime/adapters/memory";
import { createEnv } from "../../helpers/fakes";

function createMemoryGatewayStub(): MemoryGateway {
  return {
    getConfigSafe: () =>
      ({
        enabled: false,
      }) as ReturnType<
        ReturnType<(typeof import("../../../src/core/memory"))["createMemoryRuntime"]>["getConfig"]
      >,
    renderContext: async () => "",
    find: async () => ({ facts: [] }),
    save: async () => ({ ok: true }),
    remove: async () => ({ ok: true }),
    persistTurn: async () => undefined,
    factoryReset: async () => undefined,
  };
}

function createTracer(): ToolTracer {
  return {
    onToolStart: async () => undefined,
    onToolResult: async () => undefined,
  };
}

function createCodemodeHarness(options?: {
  googlePlugin?: {
    execute?: (
      payload: {
        service?: string;
        version?: string;
        method?: string;
        params?: Record<string, unknown>;
        body?: unknown;
      },
      settings: { allowedServices: string[]; timeoutMs: number },
    ) => Promise<unknown>;
  } | null;
  netFetchEnabled?: boolean;
}) {
  const { env } = createEnv();
  const workspaceGateway = createWorkspaceGateway({
    db: env.DRECLAW_DB,
    maxFileBytes: 10_000,
    maxPathLength: 255,
  });
  const reminders = createRemindersPlugin(buildRemindersPluginDeps(env));
  const toolTraces: ToolTrace[] = [];
  const runs = createRunCoordinator({ db: env.DRECLAW_DB });
  runs.throwIfCancelled = async () => undefined;
  const tools = createAgentTools(
    {
      chatId: 777,
      threadId: "telegram:777",
      tracer: createTracer(),
      toolTraces,
    },
    {
      runs,
      workspaceGateway,
      memoryGateway: createMemoryGatewayStub(),
      googlePlugin:
        options?.googlePlugin === undefined
          ? {
              execute: async (payload, settings) => {
                if (!payload.service || !settings.allowedServices.includes(payload.service)) {
                  throw new Error("GOOGLE_SERVICE_NOT_ALLOWED");
                }
                return {
                  ok: true,
                  service: payload.service,
                  method: payload.method ?? null,
                };
              },
            }
          : options.googlePlugin,
      reminders,
      getCodeExecutionConfig: () => ({
        codeExecEnabled: true,
        netFetchEnabled: options?.netFetchEnabled ?? true,
        limits: {
          execTimeoutMs: 1_000,
          execMaxOutputBytes: 10_000,
          netRequestTimeoutMs: 1_000,
          netMaxResponseBytes: 10_000,
        },
      }),
      loader: null,
    },
  );

  return {
    env,
    workspaceGateway,
    reminders,
    toolTraces,
    codemode: tools.codemode,
  };
}

describe("tool requirements", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("codemode executes JavaScript and returns a final result", async () => {
    const harness = createCodemodeHarness();

    await expect(
      harness.codemode.execute({
        code: "async () => ({ ok: true, answer: 42 })",
      }),
    ).resolves.toEqual({ ok: true, answer: 42 });
  });

  it("codemode surfaces execution failures cleanly", async () => {
    const harness = createCodemodeHarness();

    await expect(
      harness.codemode.execute({
        code: "async () => { throw new Error('boom'); }",
      }),
    ).rejects.toThrow();
  });

  it("state can write and read files through codemode", async () => {
    const harness = createCodemodeHarness();

    await expect(
      harness.codemode.execute({
        code: [
          "async () => {",
          '  await state.writeFile("/tmp/requirement.txt", "hello");',
          '  return await state.readFile("/tmp/requirement.txt");',
          "}",
        ].join("\n"),
      }),
    ).resolves.toBe("hello");
  });

  it("state can discover workspace files with glob", async () => {
    const harness = createCodemodeHarness();

    await expect(
      harness.codemode.execute({
        code: [
          "async () => {",
          '  await state.writeFile("/tmp/alpha.txt", "a");',
          '  return await state.glob("/tmp/*.txt");',
          "}",
        ].join("\n"),
      }),
    ).resolves.toContain("/tmp/alpha.txt");
  });

  it("system skills stay readable but not writable", async () => {
    const harness = createCodemodeHarness();

    await expect(
      harness.codemode.execute({
        code: 'async () => await state.readFile("/skills/system/google/SKILL.md")',
      }),
    ).resolves.toContain("google.execute");

    await expect(
      harness.codemode.execute({
        code: [
          "async () => {",
          '  await state.writeFile("/skills/system/google/SKILL.md", "nope");',
          "}",
        ].join("\n"),
      }),
    ).rejects.toThrow();
  });

  it("reserved system skill names cannot be created as user skills", async () => {
    const harness = createCodemodeHarness();

    await expect(
      harness.codemode.execute({
        code: [
          "async () => {",
          '  await state.writeFile("/skills/user/google/SKILL.md", `---',
          "name: google",
          "description: fake google skill.",
          "---",
          "",
          "# Fake",
          "`);",
          "}",
        ].join("\n"),
      }),
    ).rejects.toThrow();
  });

  it("valid user skills become listable and loadable", async () => {
    const harness = createCodemodeHarness();

    await expect(
      harness.codemode.execute({
        code: [
          "async () => {",
          '  await state.writeFile("/skills/user/inbox-helper/SKILL.md", `---',
          "name: inbox-helper",
          "description: Summarize inbox tasks.",
          "---",
          "",
          "# Inbox Helper",
          "",
          "1. Summarize inbox tasks.",
          "`);",
          "  const listed = await skills.list({});",
          '  const loaded = await skills.load({ name: "inbox-helper" });',
          "  return { listed, loaded };",
          "}",
        ].join("\n"),
      }),
    ).resolves.toMatchObject({
      listed: {
        skills: expect.arrayContaining([
          expect.objectContaining({ name: "inbox-helper", scope: "user" }),
        ]),
      },
      loaded: expect.objectContaining({
        name: "inbox-helper",
        scope: "user",
        content: expect.stringContaining("# Inbox Helper"),
      }),
    });
  });

  it("web.fetch returns a usable response on success", async () => {
    const harness = createCodemodeHarness();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("ok", { status: 200, headers: { "x-test": "1" } })),
    );

    await expect(
      harness.codemode.execute({
        code: 'async () => await web.fetch({ url: "https://example.com/test" })',
      }),
    ).resolves.toMatchObject({
      ok: true,
      status: 200,
      body: "ok",
    });
  });

  it("web.fetch surfaces request failures cleanly", async () => {
    const harness = createCodemodeHarness();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );

    await expect(
      harness.codemode.execute({
        code: 'async () => await web.fetch({ url: "https://example.com/test" })',
      }),
    ).rejects.toThrow();
  });

  it("google.execute succeeds for an allowed request", async () => {
    const harness = createCodemodeHarness();

    await expect(
      harness.codemode.execute({
        code: [
          "async () =>",
          '  await google.execute({ service: "gmail", version: "v1", method: "users.messages.list" })',
        ].join(" "),
      }),
    ).resolves.toMatchObject({
      ok: true,
      service: "gmail",
      method: "users.messages.list",
    });
  });

  it("google.execute fails cleanly when unavailable or disallowed", async () => {
    const unavailable = createCodemodeHarness({ googlePlugin: null });
    await expect(
      unavailable.codemode.execute({
        code: [
          "async () =>",
          '  await google.execute({ service: "gmail", version: "v1", method: "users.messages.list" })',
        ].join(" "),
      }),
    ).rejects.toThrow();

    const disallowed = createCodemodeHarness({
      googlePlugin: {
        execute: async (payload, settings) => {
          if (!payload.service || !settings.allowedServices.includes(payload.service)) {
            throw new Error("blocked");
          }
          return { ok: true };
        },
      },
    });
    await expect(
      disallowed.codemode.execute({
        code: [
          "async () =>",
          '  await google.execute({ service: "people", version: "v1", method: "people.get" })',
        ].join(" "),
      }),
    ).rejects.toThrow();
  });

  it("reminders can be created, queried, and updated", async () => {
    const harness = createCodemodeHarness();

    const created = await harness.codemode.execute({
      code: [
        "async () =>",
        '  await reminders.update({ action: "create", item: { title: "Follow up", notes: "Ping later" } })',
      ].join(" "),
    });
    const reminderId = (created as { item?: { id?: string } }).item?.id;
    expect(typeof reminderId).toBe("string");

    await expect(
      harness.codemode.execute({
        code: 'async () => await reminders.query({ filter: { status: "open" } })',
      }),
    ).resolves.toMatchObject({
      items: expect.arrayContaining([
        expect.objectContaining({ id: reminderId, title: "Follow up" }),
      ]),
    });

    await expect(
      harness.codemode.execute({
        code: `async () => await reminders.update({ action: "complete", itemId: "${reminderId}" })`,
      }),
    ).resolves.toMatchObject({
      item: expect.objectContaining({ id: reminderId, status: "done" }),
    });
  });

  it("skills list and load built-in skills, and missing skills fail cleanly", async () => {
    const harness = createCodemodeHarness();

    await expect(
      harness.codemode.execute({
        code: [
          "async () => {",
          "  const catalog = await skills.list({});",
          '  const loaded = await skills.load({ name: "google" });',
          "  return { catalog, loaded };",
          "}",
        ].join("\n"),
      }),
    ).resolves.toMatchObject({
      catalog: {
        skills: expect.arrayContaining([
          expect.objectContaining({ name: "google", scope: "system" }),
        ]),
      },
      loaded: expect.objectContaining({
        name: "google",
        scope: "system",
        content: expect.stringContaining("google.execute"),
      }),
    });

    await expect(
      harness.codemode.execute({
        code: 'async () => await skills.load({ name: "missing-skill" })',
      }),
    ).rejects.toThrow();
  });
});
