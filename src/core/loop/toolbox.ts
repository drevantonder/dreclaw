import { tool } from "ai";
import { z } from "zod";
import { executeBash } from "../tools/bash";
import { executeCode, getCodeExecutionConfig, type ExecuteHostBinding } from "../tools/code-exec";
import { getRemindersPlugin } from "../../plugins/reminders";
import type { RuntimeDeps } from "../app/types";
import { isRunCancelledError } from "./errors";
import {
  compactErrorMessage,
  redactSensitiveText,
  type ToolTrace,
  type ToolTracer,
} from "./tracing";
import type { WorkspaceGateway } from "./workspace-gateway";
import { createRunCoordinator } from "./run";

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
  reminders: ReturnType<typeof getRemindersPlugin>;
  getCodeExecutionConfig: () => ReturnType<typeof getCodeExecutionConfig>;
  createExecuteHostBinding: (params: {
    threadId: string;
    chatId: number;
  }) => ExecuteHostBinding | null;
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
      return { ok: false, error: trace.error } as T;
    }
  };

  return {
    vfs: tool({
      description:
        "Manage VFS files for scripts and user skills. Use this to list, read, write, patch, and delete files when file access is needed.",
      inputSchema: z.discriminatedUnion("action", [
        z.object({
          action: z.literal("list"),
          prefix: z.string().optional(),
          limit: z.number().int().min(1).max(200).optional(),
        }),
        z.object({
          action: z.literal("read"),
          path: z.string(),
          startLine: z.number().int().min(1).optional(),
          endLine: z.number().int().min(1).optional(),
        }),
        z.object({
          action: z.literal("write"),
          path: z.string(),
          content: z.string(),
          mode: z.enum(["create", "overwrite"]).default("overwrite"),
        }),
        z.object({
          action: z.literal("patch"),
          path: z.string(),
          search: z.string(),
          replace: z.string(),
          replaceAll: z.boolean().optional(),
        }),
        z.object({ action: z.literal("delete"), path: z.string() }),
      ]),
      execute: async (input) => {
        const writes: string[] = [];
        return runTool(
          "vfs",
          input as Record<string, unknown>,
          async () => {
            const workspace = deps.workspaceGateway.getWorkspace();
            switch (input.action) {
              case "list": {
                const prefix = input.prefix || "/";
                const limit = input.limit ?? 50;
                const paths = await workspace.listFiles(prefix, limit);
                return { prefix: workspace.normalizePath(prefix), paths };
              }
              case "read": {
                const content = await workspace.readFile(input.path);
                if (content === null) throw new Error(`ENOENT: ${input.path}`);
                return {
                  path: workspace.normalizePath(input.path),
                  ...sliceVfsContent(content, input.startLine, input.endLine),
                };
              }
              case "write": {
                const result = await deps.workspaceGateway.writeFile(
                  input.path,
                  input.content,
                  input.mode === "overwrite",
                  writes,
                );
                if (!result.ok) throw new Error(result.code);
                return {
                  path: result.path,
                  mode: input.mode,
                  sizeBytes: new TextEncoder().encode(input.content).byteLength,
                  lines: countLines(input.content),
                };
              }
              case "patch": {
                const current = await workspace.readFile(input.path);
                if (current === null) throw new Error(`ENOENT: ${input.path}`);
                const patched = patchVfsContent(
                  current,
                  input.search,
                  input.replace,
                  Boolean(input.replaceAll),
                );
                const result = await deps.workspaceGateway.writeFile(
                  input.path,
                  patched.content,
                  true,
                  writes,
                );
                if (!result.ok) throw new Error(result.code);
                return {
                  path: result.path,
                  replacements: patched.replacements,
                  ...sliceVfsContent(patched.content),
                };
              }
              case "delete": {
                const deleted = await deps.workspaceGateway.deleteFile(input.path, writes);
                if (!deleted) throw new Error(`ENOENT: ${input.path}`);
                return { path: workspace.normalizePath(input.path), deleted: true };
              }
            }
          },
          writes,
        );
      },
    }),
    list_skills: tool({
      description: "List available built-in and user skills by name and description",
      inputSchema: z.object({}),
      execute: async () =>
        runTool("list_skills", {}, async () => ({
          skills: await deps.workspaceGateway.listSkills(),
        })),
    }),
    load_skill: tool({
      description: "Load full instructions for a named skill for the current turn",
      inputSchema: z.object({ name: z.string() }),
      execute: async (input) =>
        runTool("load_skill", input as Record<string, unknown>, async () => {
          const skill = await deps.workspaceGateway.getWorkspace().loadSkill(input.name);
          if (!skill) throw new Error(`SKILL_NOT_FOUND: ${input.name}`);
          return {
            name: skill.name,
            description: skill.description,
            scope: skill.scope,
            path: skill.path,
            content: skill.content,
          };
        }),
    }),
    reminders_query: tool({
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
      execute: async (input) =>
        runTool("reminders_query", input as Record<string, unknown>, async () => ({
          items: await deps.reminders.queryReminders(input.filter, input.limit ?? 20),
        })),
    }),
    reminders_update: tool({
      description:
        "Create or update the assistant's internal reminders. Use this to track follow-ups, reschedule wakes, snooze items, or mark them complete.",
      inputSchema: z.discriminatedUnion("action", [
        z.object({
          action: z.literal("create"),
          item: z.object({
            kind: z.string().optional(),
            title: z.string(),
            notes: z.string().optional(),
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
        z.object({ action: z.literal("reschedule"), itemId: z.string(), nextWakeAt: z.string() }),
        z.object({ action: z.literal("append_note"), itemId: z.string(), note: z.string() }),
      ]),
      execute: async (input) =>
        runTool("reminders_update", input as Record<string, unknown>, async () =>
          deps.reminders.updateReminder(input, { sourceChatId: params.chatId }),
        ),
    }),
    bash: tool({
      description:
        "Run bash commands in a sandboxed shell with core Unix tools, VFS-backed files, and full network access via curl. Use this for shell/text/file/network tasks. Use execute instead for JavaScript, google.execute, memory.*, or fs.* runtime work.",
      inputSchema: z.object({
        command: z.string(),
        cwd: z.string().optional(),
        stdin: z.string().optional(),
      }),
      execute: async (input) => {
        const writes: string[] = [];
        return runTool(
          "bash",
          input as Record<string, unknown>,
          async () =>
            executeBash(
              { command: input.command, cwd: input.cwd, stdin: input.stdin },
              {
                config: {
                  execMaxOutputBytes: deps.getCodeExecutionConfig().limits.execMaxOutputBytes,
                  netRequestTimeoutMs: deps.getCodeExecutionConfig().limits.netRequestTimeoutMs,
                  netMaxResponseBytes: deps.getCodeExecutionConfig().limits.netMaxResponseBytes,
                  netMaxRedirects: deps.getCodeExecutionConfig().limits.netMaxRedirects,
                  vfsMaxFiles: deps.getCodeExecutionConfig().limits.vfsMaxFiles,
                },
                vfs: deps.workspaceGateway.createVfsAdapter(writes),
              },
            ),
          writes,
        );
      },
    }),
    execute: tool({
      description:
        "Run JavaScript in a sandboxed Worker runtime with async/await, fetch, fs.read/fs.write/fs.list/fs.remove, memory.*, and built-in global `google`. Return the final value explicitly. VFS is file storage exposed through fs.* only. For repeated logic, keep code inline or copy in the small helper you need. For user-facing report tasks, prefer returning a final string summary. Load relevant skills first for specialized guidance.",
      inputSchema: z.object({ code: z.string(), input: z.unknown().optional() }),
      execute: async (input) => {
        const writes: string[] = [];
        return runTool(
          "execute",
          input as Record<string, unknown>,
          async () =>
            executeCode(
              { code: input.code, input: input.input },
              {
                config: deps.getCodeExecutionConfig(),
                loader: deps.loader ?? null,
                host: deps.createExecuteHostBinding({
                  threadId: params.threadId,
                  chatId: params.chatId,
                }),
              },
            ),
          writes,
        );
      },
    }),
  };
}

export function sliceVfsContent(content: string, startLine?: number, endLine?: number) {
  const lines = content.split("\n");
  const start = Math.max(1, Math.min(lines.length || 1, startLine ?? 1));
  const end = Math.max(start, Math.min(lines.length || start, endLine ?? lines.length));
  return {
    content: lines.slice(start - 1, end).join("\n"),
    totalLines: lines.length,
    startLine: start,
    endLine: end,
  };
}

export function patchVfsContent(
  content: string,
  search: string,
  replace: string,
  replaceAll: boolean,
) {
  if (!search) throw new Error("PATCH_INVALID: search must be non-empty");
  const occurrences = countOccurrences(content, search);
  if (occurrences === 0) throw new Error("PATCH_NOT_FOUND");
  if (!replaceAll && occurrences > 1) throw new Error("PATCH_AMBIGUOUS");
  return {
    content: replaceAll ? content.split(search).join(replace) : content.replace(search, replace),
    replacements: replaceAll ? occurrences : 1,
  };
}

function countOccurrences(content: string, search: string): number {
  let count = 0;
  let index = 0;
  while (true) {
    index = content.indexOf(search, index);
    if (index === -1) return count;
    count += 1;
    index += Math.max(1, search.length);
  }
}

function countLines(content: string): number {
  return content ? content.split("\n").length : 0;
}
