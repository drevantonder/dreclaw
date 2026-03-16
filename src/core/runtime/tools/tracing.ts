import type { Thread } from "chat";
import { getPersistedThreadControls } from "../../loop/repo";
import type { BotThreadState } from "../../loop/state";

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

  async onToolStart(name: string, args: Record<string, unknown>): Promise<void> {
    if (!(await this.isEnabled())) return;
    await this.thread.post({ markdown: renderTraceStart(name, args) });
  }

  async onToolResult(trace: ToolTrace): Promise<void> {
    if (!(await this.isEnabled())) return;
    await this.thread.post({ markdown: renderTraceResult(trace) });
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
  if (name === "load_skill") {
    const skillName = typeof args.name === "string" ? args.name : serializeUnknown(args.name);
    return `Tool: ${name}\nname: ${skillName}`;
  }
  if (name === "list_skills") return `Tool: ${name}`;
  if (name === "vfs") {
    const action = typeof args.action === "string" ? args.action : serializeUnknown(args.action);
    const path = typeof args.path === "string" ? `\npath: ${args.path}` : "";
    const prefix = typeof args.prefix === "string" ? `\nprefix: ${args.prefix}` : "";
    return `Tool: ${name}\naction: ${action}${path}${prefix}`;
  }
  if (name === "bash") {
    const command = typeof args.command === "string" ? args.command : "";
    const cwd = typeof args.cwd === "string" ? `\ncwd: ${args.cwd}` : "";
    const stdin =
      typeof args.stdin === "string" && args.stdin
        ? `\nstdin: ${redactSensitiveText(args.stdin)}`
        : "";
    return `Tool: ${name}\n\n\`\`\`bash\n${command}\n\`\`\`${cwd}${stdin}`;
  }
  if (name === "execute") {
    const code = typeof args.code === "string" ? args.code : "";
    const input = Object.prototype.hasOwnProperty.call(args, "input")
      ? `\ninput: ${redactSensitiveText(serializeUnknown(args.input))}`
      : "";
    return `Tool: ${name}\n\n\`\`\`js\n${code}\n\`\`\`${input}`;
  }
  return `Tool: ${name}\nargs: ${redactSensitiveText(serializeUnknown(args))}`;
}

export function renderTraceResult(trace: ToolTrace): string {
  const executeOk =
    trace.name === "execute" &&
    trace.output &&
    typeof trace.output === "object" &&
    "ok" in (trace.output as Record<string, unknown>)
      ? Boolean((trace.output as Record<string, unknown>).ok)
      : trace.ok;
  const lines = [`Tool result: ${trace.name} ${executeOk ? "ok" : "failed"}`];
  if (trace.ok && trace.name === "load_skill" && trace.output && typeof trace.output === "object") {
    const output = trace.output as Record<string, unknown>;
    lines.push(`loaded: ${serializeUnknown(output.name)}`);
    lines.push(`scope: ${serializeUnknown(output.scope)}`);
    lines.push(`path: ${serializeUnknown(output.path)}`);
    return lines.join("\n");
  }
  if (
    trace.ok &&
    trace.name === "list_skills" &&
    trace.output &&
    typeof trace.output === "object"
  ) {
    const skills = Array.isArray((trace.output as { skills?: unknown[] }).skills)
      ? ((trace.output as { skills: unknown[] }).skills as unknown[])
      : [];
    lines.push(`skills: ${skills.length}`);
    lines.push(
      `result: ${redactSensitiveText(truncateForLog(serializeUnknown(trace.output), 600))}`,
    );
    return lines.join("\n");
  }
  if (trace.ok && trace.name === "vfs") {
    lines.push(
      `result: ${redactSensitiveText(truncateForLog(serializeUnknown(trace.output), 1200))}`,
    );
    return lines.join("\n");
  }
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
