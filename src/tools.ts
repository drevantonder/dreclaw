import { WORKSPACE_ROOT, type RunResult, type ToolCall } from "./types";
import type { SandboxClient } from "@cloudflare/sandbox";

export function extractToolCall(output: string): ToolCall | null {
  const trimmed = output.trim();
  if (!trimmed) return null;

  const direct = tryParseJson(trimmed);
  if (direct) return normalizeToolCall(direct);

  const fenced = /```json\s*([\s\S]*?)\s*```/i.exec(trimmed)?.[1];
  if (fenced) {
    const parsed = tryParseJson(fenced);
    if (parsed) return normalizeToolCall(parsed);
  }

  return null;
}

export async function runToolInSandbox(tool: ToolCall, sandbox: SandboxClient): Promise<RunResult> {
  try {
    const env = sandboxEnv();

    if (tool.name === "read") {
      const path = normalizePath(String(tool.args.path ?? ""));
      const file = await sandbox.readFile(path);
      return { ok: true, output: file.content ?? "" };
    }

    if (tool.name === "write") {
      const path = normalizePath(String(tool.args.path ?? ""));
      const content = String(tool.args.content ?? "");
      await sandbox.writeFile(path, content);
      return { ok: true, output: `Wrote ${path}` };
    }

    if (tool.name === "edit") {
      const path = normalizePath(String(tool.args.path ?? ""));
      const find = String(tool.args.find ?? "");
      const replace = String(tool.args.replace ?? "");
      const current = await sandbox.readFile(path);
      if (!current.content.includes(find)) {
        return { ok: false, output: "", error: `Text not found in ${path}` };
      }
      await sandbox.writeFile(path, current.content.replace(find, replace));
      return { ok: true, output: `Edited ${path}` };
    }

    const cmd = String(tool.args.command ?? "");
    const result = await sandbox.exec(`bash -lc ${shellQuote(cmd)}`, { cwd: WORKSPACE_ROOT, env });
    return toRunResult(result);
  } catch (error) {
    return {
      ok: false,
      output: "",
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

function tryParseJson(input: string): unknown | null {
  try {
    return JSON.parse(input);
  } catch {
    return null;
  }
}

function normalizeToolCall(input: unknown): ToolCall | null {
  if (!input || typeof input !== "object") return null;
  const data = input as Record<string, unknown>;
  const root = (data.tool && typeof data.tool === "object" ? data.tool : data) as Record<string, unknown>;
  const name = String(root.name ?? "");
  if (!isToolName(name)) return null;
  const args = (root.args && typeof root.args === "object" ? root.args : {}) as Record<string, unknown>;
  return { name, args };
}

function isToolName(value: string): value is ToolCall["name"] {
  return value === "read" || value === "write" || value === "edit" || value === "bash";
}

function sandboxEnv(): Record<string, string> {
  return {
    HOME: WORKSPACE_ROOT,
    XDG_CONFIG_HOME: `${WORKSPACE_ROOT}/.config`,
    XDG_CACHE_HOME: `${WORKSPACE_ROOT}/.cache`,
  };
}

function normalizePath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return WORKSPACE_ROOT;
  if (trimmed.startsWith("/")) return trimmed;
  return `${WORKSPACE_ROOT}/${trimmed}`.replace(/\/{2,}/g, "/");
}

function shellQuote(input: string): string {
  return `'${input.replace(/'/g, `'"'"'`)}'`;
}

function toRunResult(result: { success: boolean; stdout?: string; stderr?: string; exitCode?: number }): RunResult {
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const output = [stdout, stderr].filter(Boolean).join("\n").trim();
  if (result.success) return { ok: true, output };
  const code = typeof result.exitCode === "number" ? ` (exit ${result.exitCode})` : "";
  return {
    ok: false,
    output,
    error: `Command failed${code}`,
  };
}
