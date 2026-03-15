import { WorkerEntrypoint } from "cloudflare:workers";
import { buildRuntimeDeps } from "../app/deps";
import { createMemoryRuntime } from "../core/memory";
import { getRemindersPlugin, type ReminderUpdateInput } from "../plugins/reminders";
import type { Env } from "./env";
import { createWorkspace } from "../core/vfs";

export interface ExecuteHostProps {
  chatId: number;
  threadId: string;
  limits: {
    execMaxOutputBytes: number;
    execMaxLogLines: number;
    netRequestTimeoutMs: number;
    netMaxResponseBytes: number;
    vfsMaxFileBytes: number;
    vfsListLimit: number;
  };
  allowedGoogleServices: string[];
}

type ExecuteHostCall =
  | { action: "fs.read"; path: string }
  | { action: "fs.write"; path: string; content: string; overwrite?: boolean }
  | { action: "fs.list"; prefix?: string }
  | { action: "fs.remove"; path: string }
  | { action: "memory.find"; payload: unknown }
  | { action: "memory.save"; payload: unknown }
  | { action: "memory.remove"; payload: unknown }
  | { action: "reminders.query"; payload: { filter?: unknown; limit?: number } }
  | { action: "reminders.update"; payload: ReminderUpdateInput }
  | {
      action: "fetch";
      request: {
        url: string;
        method?: string;
        headers?: Array<[string, string]>;
        bodyBase64?: string | null;
      };
    }
  | {
      action: "google.execute";
      payload: {
        service?: string;
        version?: string;
        method?: string;
        params?: Record<string, unknown>;
        body?: unknown;
      };
    };

export class ExecuteHost extends WorkerEntrypoint<Env, ExecuteHostProps> {
  async call(input: ExecuteHostCall): Promise<unknown> {
    switch (input.action) {
      case "fs.read":
        return this.readVfsContent(input.path);
      case "fs.write":
        return this.writeVfsContent(input.path, input.content, Boolean(input.overwrite));
      case "fs.list":
        return this.listVfsPaths(input.prefix ?? "/");
      case "fs.remove":
        return this.deleteVfsContent(input.path);
      case "memory.find":
        return this.executeMemoryFindPayload(input.payload);
      case "memory.save":
        return this.executeMemorySavePayload(input.payload);
      case "memory.remove":
        return this.executeMemoryRemovePayload(input.payload);
      case "reminders.query":
        return this.executeRemindersQuery(input.payload);
      case "reminders.update":
        return this.executeRemindersUpdate(input.payload);
      case "fetch":
        return this.executeFetch(input.request);
      case "google.execute":
        return this.executeGoogle(input.payload);
      default:
        throw new Error("EXECUTE_HOST_UNSUPPORTED_ACTION");
    }
  }

  private props(): ExecuteHostProps {
    return (this.ctx.props ?? {}) as ExecuteHostProps;
  }

  private async readVfsContent(path: string): Promise<string | null> {
    return this.workspace().readFile(path);
  }

  private async writeVfsContent(path: string, content: string, overwrite: boolean) {
    return this.workspace().writeFile(path, content, overwrite);
  }

  private async listVfsPaths(prefix: string): Promise<string[]> {
    return this.workspace().listFiles(prefix || "/", Math.max(1, this.props().limits.vfsListLimit));
  }

  private async deleteVfsContent(path: string): Promise<boolean> {
    return this.workspace().removeFile(path);
  }

  private workspace() {
    return createWorkspace({
      db: this.env.DRECLAW_DB,
      maxFileBytes: this.props().limits.vfsMaxFileBytes,
    });
  }

  private async executeMemoryFindPayload(payload: unknown): Promise<unknown> {
    return this.memory().find({ chatId: this.props().chatId, payload });
  }

  private async executeMemorySavePayload(payload: unknown): Promise<unknown> {
    return this.memory().save({ chatId: this.props().chatId, payload });
  }

  private async executeMemoryRemovePayload(payload: unknown): Promise<unknown> {
    return this.memory().remove({ chatId: this.props().chatId, payload });
  }

  private memory() {
    const runtimeDeps = buildRuntimeDeps(this.env);
    return createMemoryRuntime({
      db: runtimeDeps.DRECLAW_DB,
      aiBinding: runtimeDeps.AI,
      vectorIndex: runtimeDeps.VECTORIZE_MEMORY,
      settings: {
        enabled: runtimeDeps.MEMORY_ENABLED,
        retentionDays: runtimeDeps.MEMORY_RETENTION_DAYS,
        maxInjectTokens: runtimeDeps.MEMORY_MAX_INJECT_TOKENS,
        reflectionEveryTurns: runtimeDeps.MEMORY_REFLECTION_EVERY_TURNS,
        embeddingModel: runtimeDeps.MEMORY_EMBEDDING_MODEL,
      },
    });
  }

  private reminders() {
    return getRemindersPlugin(buildRuntimeDeps(this.env).pluginRegistry.getByName("reminders"));
  }

  private async executeRemindersQuery(payload: { filter?: unknown; limit?: number }) {
    return {
      items: await this.reminders().queryReminders(payload.filter as never, payload.limit ?? 20),
    };
  }

  private async executeRemindersUpdate(payload: ReminderUpdateInput): Promise<unknown> {
    return this.reminders().updateReminder(payload, { sourceChatId: this.props().chatId });
  }

  private async executeFetch(request: {
    url: string;
    method?: string;
    headers?: Array<[string, string]>;
    bodyBase64?: string | null;
  }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.props().limits.netRequestTimeoutMs);
    try {
      const response = await fetch(request.url, {
        method: request.method || "GET",
        headers: request.headers ?? [],
        body: request.bodyBase64 ? new Blob([decodeBase64(request.bodyBase64)]) : undefined,
        signal: controller.signal,
      });
      const body = await response.arrayBuffer();
      if (body.byteLength > this.props().limits.netMaxResponseBytes) {
        throw new Error("FETCH_RESPONSE_TOO_LARGE");
      }
      return {
        url: response.url,
        status: response.status,
        statusText: response.statusText,
        headers: collectHeaders(response.headers),
        bodyBase64: encodeBase64(body),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private async executeGoogle(payload: {
    service?: string;
    version?: string;
    method?: string;
    params?: Record<string, unknown>;
    body?: unknown;
  }): Promise<unknown> {
    const google = this.google();
    if (!google?.execute) throw new Error("GOOGLE_PLUGIN_UNAVAILABLE");
    return google.execute(payload, {
      allowedServices: this.props().allowedGoogleServices,
      timeoutMs: this.props().limits.netRequestTimeoutMs,
    });
  }

  private google() {
    return buildRuntimeDeps(this.env).pluginRegistry.getByName("google");
  }
}

function collectHeaders(headers: Headers): Array<[string, string]> {
  const values: Array<[string, string]> = [];
  headers.forEach((value, key) => {
    values.push([key, value]);
  });
  return values;
}

function encodeBase64(input: ArrayBuffer): string {
  let output = "";
  for (const value of new Uint8Array(input)) output += String.fromCharCode(value);
  return btoa(output);
}

function decodeBase64(input: string): ArrayBuffer {
  const raw = atob(input);
  const output = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) output[index] = raw.charCodeAt(index);
  return output.buffer as ArrayBuffer;
}
