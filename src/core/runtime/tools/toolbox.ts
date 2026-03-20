import { DynamicWorkerExecutor, normalizeCode } from "@cloudflare/codemode";
import { createCodeTool, resolveProvider } from "@cloudflare/codemode/ai";
import { stateToolsFromBackend } from "@cloudflare/shell/workers";
import { tool } from "ai";
import { z } from "zod";
import { getRemindersPlugin } from "../../../plugins/reminders";
import type { RuntimeDeps } from "../../app/types";
import { createRunCoordinator } from "../../loop/run";
import { isRunCancelledError } from "../lib/errors";
import {
  compactErrorMessage,
  redactSensitiveText,
  type ToolTrace,
  type ToolTracer,
} from "./tracing";
import type { MemoryGateway } from "../adapters/memory";
import type { WorkspaceGateway } from "../adapters/workspace";

const scheduleSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("once"),
    atLocal: z.string(),
  }),
  z.object({
    type: z.literal("recurring"),
    cadence: z.enum(["daily", "weekdays", "weekly", "monthly"]),
    atLocalTime: z.string(),
    daysOfWeek: z.array(z.number().int().min(0).max(6)).optional(),
    dayOfMonth: z.number().int().min(1).max(31).optional(),
    interval: z.number().int().min(1).max(365).optional(),
  }),
]);

export interface AgentToolsDeps {
  runs: ReturnType<typeof createRunCoordinator>;
  workspaceGateway: WorkspaceGateway;
  memoryGateway: MemoryGateway;
  googlePlugin?: {
    execute?: (
      payload: {
        service?: string;
        version?: string;
        method?: string;
        params?: Record<string, unknown>;
        body?: unknown;
      },
      options: { allowedServices: string[]; timeoutMs: number },
    ) => Promise<unknown>;
  } | null;
  reminders: ReturnType<typeof getRemindersPlugin>;
  getCodeExecutionConfig: () => {
    codeExecEnabled: boolean;
    netFetchEnabled: boolean;
    limits: {
      execTimeoutMs: number;
      execMaxOutputBytes: number;
      netRequestTimeoutMs: number;
      netMaxResponseBytes: number;
    };
  };
  loader: RuntimeDeps["LOADER"] | null | undefined;
}

export interface AgentToolsParams {
  chatId: number;
  threadId: string;
  tracer: ToolTracer;
  toolTraces: ToolTrace[];
}

export type CreateAgentTools = (params: AgentToolsParams) => ReturnType<typeof createAgentTools>;

export function createAgentTools(params: AgentToolsParams, deps: AgentToolsDeps) {
  const runTool = async <T>(
    name: string,
    args: Record<string, unknown>,
    execute: () => Promise<T>,
    writes?: string[],
  ) => {
    await deps.runs.throwIfCancelled(params.threadId);
    await params.tracer.onToolStart(name, args);
    try {
      const result = await execute();
      await deps.runs.throwIfCancelled(params.threadId);
      const trace: ToolTrace = { name, args, ok: true, output: result, writes };
      params.toolTraces.push(trace);
      await params.tracer.onToolResult(trace);
      return result;
    } catch (error) {
      if (isRunCancelledError(error)) throw error;
      const trace: ToolTrace = {
        name,
        args,
        ok: false,
        error: redactSensitiveText(compactErrorMessage(error)),
        writes,
      };
      params.toolTraces.push(trace);
      await params.tracer.onToolResult(trace);
      throw error;
    }
  };

  const config = deps.getCodeExecutionConfig();
  const executor = new DynamicWorkerExecutor({
    loader: deps.loader as never,
    timeout: config.limits.execTimeoutMs,
    globalOutbound: null,
  } as never);

  const stateWrites: string[] = [];
  const stateProvider = stateToolsFromBackend(
    deps.workspaceGateway.createStateBackend(stateWrites),
  );
  const memoryProvider = {
    name: "memory",
    tools: {
      find: tool({
        description: "Find durable memories relevant to a query.",
        inputSchema: z.object({
          query: z.string().default(""),
          topK: z.number().int().min(1).max(20).optional(),
        }),
        execute: async (input) =>
          deps.memoryGateway.find({ chatId: params.chatId, payload: input }),
      }),
      save: tool({
        description: "Save a durable memory fact, preference, or goal.",
        inputSchema: z.object({
          text: z.string(),
          kind: z.enum(["preference", "fact", "goal", "identity"]).optional(),
          confidence: z.number().min(0).max(1).optional(),
        }),
        execute: async (input) =>
          deps.memoryGateway.save({ chatId: params.chatId, payload: input }),
      }),
      remove: tool({
        description: "Remove a stored memory by id or matching text target.",
        inputSchema: z.object({ target: z.string() }),
        execute: async (input) =>
          deps.memoryGateway.remove({ chatId: params.chatId, payload: input }),
      }),
    },
  } as const;
  const googleProvider = {
    name: "google",
    tools: {
      execute: tool({
        description: "Run an allowed Google API request.",
        inputSchema: z.object({
          service: z.string().optional(),
          version: z.string().optional(),
          method: z.string().optional(),
          params: z.record(z.string(), z.unknown()).optional(),
          body: z.unknown().optional(),
        }),
        execute: async (input) => {
          if (!deps.googlePlugin?.execute) throw new Error("GOOGLE_PLUGIN_UNAVAILABLE");
          return deps.googlePlugin.execute(input, {
            allowedServices: ["gmail", "drive", "sheets", "docs", "calendar"],
            timeoutMs: config.limits.netRequestTimeoutMs,
          });
        },
      }),
    },
  } as const;
  const webProvider = {
    name: "web",
    tools: {
      fetch: tool({
        description: "Fetch a web URL and return the response body as text or JSON.",
        inputSchema: z.object({
          url: z.string().url(),
          method: z.string().optional(),
          headers: z.record(z.string(), z.string()).optional(),
          body: z.string().optional(),
          responseType: z.enum(["text", "json"]).optional(),
        }),
        execute: async (input) => {
          if (!config.netFetchEnabled) throw new Error("NET_FETCH_DISABLED");
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), config.limits.netRequestTimeoutMs);
          try {
            const response = await fetch(input.url, {
              method: input.method ?? (input.body ? "POST" : "GET"),
              headers: input.headers,
              body: input.body,
              signal: controller.signal,
            });
            const text = await response.text();
            if (new TextEncoder().encode(text).byteLength > config.limits.netMaxResponseBytes) {
              throw new Error(
                `NET_RESPONSE_TOO_LARGE: max ${config.limits.netMaxResponseBytes} bytes`,
              );
            }
            const headers = Object.fromEntries(response.headers.entries());
            return {
              ok: response.ok,
              status: response.status,
              url: response.url,
              headers,
              body: (input.responseType ?? "text") === "json" ? JSON.parse(text || "null") : text,
            };
          } finally {
            clearTimeout(timeout);
          }
        },
      }),
    },
  } as const;
  const remindersProvider = {
    name: "reminders",
    tools: {
      query: tool({
        description:
          "Query the assistant's internal reminders of follow-ups, recurring responsibilities, and wake-ups.",
        inputSchema: z.object({
          filter: z
            .object({
              status: z.enum(["open", "done", "cancelled"]).optional(),
              kind: z.string().optional(),
              text: z.string().optional(),
              dueBefore: z.string().optional(),
              sourceChatId: z.number().int().optional(),
            })
            .optional(),
          limit: z.number().int().min(1).max(50).optional(),
        }),
        execute: async (input) => ({
          items: await deps.reminders.queryReminders(input.filter, input.limit ?? 20),
        }),
      }),
      update: tool({
        description:
          "Create or update the assistant's internal reminders. Use this to track follow-ups, reschedule wakes, snooze items, or mark them complete.",
        inputSchema: z.discriminatedUnion("action", [
          z.object({
            action: z.literal("create"),
            item: z.object({
              kind: z.string().optional(),
              title: z.string(),
              notes: z.string().optional(),
              delivery: z.enum(["visible", "silent"]).optional(),
              priority: z.number().int().min(1).max(5).optional(),
              nextWakeAt: z.string().nullable().optional(),
              schedule: scheduleSchema.optional(),
              sourceChatId: z.number().int().nullable().optional(),
            }),
          }),
          z.object({
            action: z.literal("patch"),
            itemId: z.string(),
            patch: z.object({
              kind: z.string().optional(),
              title: z.string().optional(),
              notes: z.string().optional(),
              delivery: z.enum(["visible", "silent"]).optional(),
              priority: z.number().int().min(1).max(5).optional(),
              nextWakeAt: z.string().nullable().optional(),
              schedule: scheduleSchema.nullable().optional(),
              sourceChatId: z.number().int().nullable().optional(),
              status: z.enum(["open", "done", "cancelled"]).optional(),
            }),
          }),
          z.object({ action: z.literal("complete"), itemId: z.string() }),
          z.object({ action: z.literal("cancel"), itemId: z.string() }),
          z.object({ action: z.literal("snooze"), itemId: z.string(), nextWakeAt: z.string() }),
          z.object({
            action: z.literal("reschedule"),
            itemId: z.string(),
            nextWakeAt: z.string(),
          }),
          z.object({ action: z.literal("append_note"), itemId: z.string(), note: z.string() }),
        ]),
        execute: async (input) =>
          deps.reminders.updateReminder(input, { sourceChatId: params.chatId }),
      }),
    },
  } as const;
  const skillsProvider = {
    name: "skills",
    tools: {
      list: tool({
        description: "List available built-in and user skills by name and description.",
        inputSchema: z.object({}),
        execute: async () => ({ skills: await deps.workspaceGateway.listSkills() }),
      }),
      load: tool({
        description: "Load full instructions for a named skill.",
        inputSchema: z.object({ name: z.string() }),
        execute: async ({ name }) => {
          const [skill] = await deps.workspaceGateway.getLoadedSkills([name]);
          if (!skill) throw new Error(`SKILL_NOT_FOUND: ${name}`);
          return {
            name: skill.name,
            description: skill.description,
            scope: skill.scope,
            path: skill.path,
            content: skill.content,
          };
        },
      }),
    },
  } as const;

  const codemodeProviders = [
    stateProvider,
    webProvider,
    memoryProvider,
    googleProvider,
    remindersProvider,
    skillsProvider,
  ] as const;
  const codemode = createCodeTool({
    tools: codemodeProviders,
    executor,
    description: [
      "Execute JavaScript to achieve the goal.",
      "",
      "Available namespaces:",
      "{{types}}",
      "",
      "Also available:",
      "- console.log / console.warn / console.error.",
      "",
      "Write an async arrow function in JavaScript that returns the final result.",
      "Do not use TypeScript syntax.",
      "Prefer state.* for file and workspace operations.",
      "Use web.fetch(...) for outbound web requests.",
      "Use memory.*, google.execute(...), reminders.*, and skills.* when needed.",
    ].join("\n"),
  } as never);
  const resolvedCodemodeProviders = codemodeProviders.map((provider) =>
    resolveProvider(provider as never),
  );

  return {
    codemode: {
      ...codemode,
      execute: async (input: { code: string }) =>
        runTool(
          "codemode",
          input as Record<string, unknown>,
          async () => {
            stateWrites.length = 0;
            const execution = await executor.execute(
              prepareCodemodeCode(input.code),
              resolvedCodemodeProviders as never,
            );
            if (execution.error) {
              const logCtx = execution.logs?.length
                ? `\n\nConsole output:\n${execution.logs.join("\n")}`
                : "";
              throw new Error(`Code execution failed: ${execution.error}${logCtx}`);
            }
            return execution.result;
          },
          stateWrites,
        ),
    },
  };
}

function prepareCodemodeCode(code: string): string {
  const normalized = normalizeCode(code).trim();
  if (!normalized) return "async () => undefined";
  if (
    /^(async\s*)?\([^)]*\)\s*=>/.test(normalized) ||
    /^(async\s+)?[A-Za-z_$][\w$]*\s*=>/.test(normalized) ||
    /^async\s+function\b/.test(normalized) ||
    /^function\b/.test(normalized)
  ) {
    return normalized;
  }
  return `async () => {\n${normalized}\n}`;
}
