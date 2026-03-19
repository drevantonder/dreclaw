import type { Thread } from "chat";
import { getPersistedThreadControls } from "../../loop/repo";
import type { BotThreadState } from "../../loop/state";
import { withTimeout } from "../../../utils/async";

const TRACE_POST_TIMEOUT_MS = 5_000;

export type ToolTrace = {
  name: string;
  args: Record<string, unknown>;
  ok: boolean;
  output?: unknown;
  error?: string;
  writes?: string[];
};

export interface ToolTracer {
  onToolStart(name: string, args: Record<string, unknown>): Promise<void>;
  onToolResult(trace: ToolTrace): Promise<void>;
}

export class VerboseTracer implements ToolTracer {
  constructor(
    private readonly db: D1Database,
    private readonly thread: Thread<BotThreadState>,
  ) {}

  private async isEnabled(): Promise<boolean> {
    const controls = await getPersistedThreadControls(this.db, this.thread.id);
    return Boolean(controls?.verbose);
  }

  private async postMarkdown(markdown: string): Promise<void> {
    await withTimeout(
      this.thread.post({ markdown }),
      TRACE_POST_TIMEOUT_MS,
      "Verbose trace post timed out",
    ).catch(() => null);
  }

  async onToolStart(name: string, args: Record<string, unknown>): Promise<void> {
    if (!(await this.isEnabled())) return;
    await this.postMarkdown(renderTraceStart(name, args));
  }

  async onToolResult(trace: ToolTrace): Promise<void> {
    if (!(await this.isEnabled())) return;
    await this.postMarkdown(renderTraceResult(trace));
  }
}

export class NoopTracer implements ToolTracer {
  async onToolStart(): Promise<void> {
    return;
  }

  async onToolResult(): Promise<void> {
    return;
  }
}

export function renderToolTranscript(trace: ToolTrace): string {
  return [
    `tool=${trace.name}`,
    `ok=${trace.ok}`,
    `args=${redactSensitiveText(serializeUnknown(trace.args))}`,
    trace.writes?.length ? `writes=${trace.writes.join(", ")}` : "",
    trace.ok
      ? `output=${redactSensitiveText(truncateForLog(serializeUnknown(trace.output), 1200))}`
      : `error=${trace.error || "tool failed"}`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function renderTraceStart(name: string, args: Record<string, unknown>): string {
  if (name === "codemode") {
    const code = typeof args.code === "string" ? args.code : "";
    return `Tool: ${name}\n\n\`\`\`js\n${code}\n\`\`\``;
  }
  return `Tool: ${name}\nargs: ${redactSensitiveText(serializeUnknown(args))}`;
}

export function renderTraceResult(trace: ToolTrace): string {
  const lines = [`Tool result: ${trace.name} ${trace.ok ? "ok" : "failed"}`];
  if (trace.writes?.length) lines.push(`writes: ${trace.writes.join(", ")}`);
  if (trace.ok) {
    lines.push(
      `result: ${redactSensitiveText(truncateForLog(serializeUnknown(trace.output), 1200))}`,
    );
  } else {
    lines.push(`error: ${trace.error || "tool failed"}`);
  }
  return lines.join("\n");
}

export function truncateForLog(input: string, max: number): string {
  const compact = String(input ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!compact) return "";
  return compact.length <= max ? compact : `${compact.slice(0, max - 1)}...`;
}

export function compactErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (typeof error === "number" || typeof error === "boolean" || typeof error === "bigint") {
    return `${error}`;
  }
  if (typeof error === "symbol") return error.description ?? "Symbol";
  try {
    return JSON.stringify(error);
  } catch {
    return error == null ? "unknown error" : Object.prototype.toString.call(error);
  }
}

export function serializeUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return `${value}`;
  }
  if (typeof value === "symbol") return value.description ?? "Symbol";
  try {
    return JSON.stringify(value);
  } catch {
    return value == null ? "" : Object.prototype.toString.call(value);
  }
}

export function redactSensitiveText(input: string): string {
  let redacted = String(input ?? "");
  for (const pattern of [
    /(api[_-]?key\s*[:=]\s*)([^\s,;]+)/gi,
    /(token\s*[:=]\s*)([^\s,;]+)/gi,
    /(secret\s*[:=]\s*)([^\s,;]+)/gi,
    /(authorization\s*[:=]\s*)([^\s,;]+)/gi,
    /(bearer\s+)([^\s,;]+)/gi,
  ]) {
    redacted = redacted.replace(pattern, (_match, prefix: string) => `${prefix}[REDACTED]`);
  }
  return redacted;
}
