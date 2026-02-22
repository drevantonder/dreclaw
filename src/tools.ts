import { WORKSPACE_ROOT, type RunResult, type ToolCall } from "./types";
import { Workspace } from "./workspace";

export function parseToolCall(text: string): ToolCall | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/tool ")) return null;
  const rest = trimmed.slice(6).trim();
  const firstSpace = rest.indexOf(" ");
  const name = (firstSpace === -1 ? rest : rest.slice(0, firstSpace)) as ToolCall["name"];
  if (!["read", "write", "edit", "bash"].includes(name)) return null;
  const argsText = firstSpace === -1 ? "{}" : rest.slice(firstSpace + 1).trim();
  try {
    const args = JSON.parse(argsText) as Record<string, unknown>;
    return { name, args };
  } catch {
    return null;
  }
}

export function runTool(tool: ToolCall, workspace: Workspace): RunResult {
  try {
    if (tool.name === "read") {
      const path = String(tool.args.path ?? "");
      return { ok: true, output: workspace.read(path) };
    }
    if (tool.name === "write") {
      const path = String(tool.args.path ?? "");
      const content = String(tool.args.content ?? "");
      workspace.write(path, content);
      return { ok: true, output: `Wrote ${path}` };
    }
    if (tool.name === "edit") {
      const path = String(tool.args.path ?? "");
      const find = String(tool.args.find ?? "");
      const replace = String(tool.args.replace ?? "");
      workspace.edit(path, find, replace);
      return { ok: true, output: `Edited ${path}` };
    }
    const cmd = String(tool.args.command ?? "");
    return runBashLike(cmd, workspace);
  } catch (error) {
    return {
      ok: false,
      output: "",
      error: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

export function runOwnerExec(command: string, workspace: Workspace): RunResult {
  const trimmed = command.trim();
  const loginMatch = /^pi-ai\s+login(?:\s+(.+))?$/i.exec(trimmed);
  const shorthandMatch = /^pi-ai\s+openai-codex$/i.exec(trimmed);

  if (loginMatch || shorthandMatch) {
    const provider = (loginMatch?.[1]?.trim() || "openai-codex").toLowerCase();
    workspace.write(`${WORKSPACE_ROOT}/.pi-ai/auth.json`, JSON.stringify({ provider, at: Date.now() }));
    return {
      ok: true,
      output: [`Provider auth stored for ${provider}.`, "Run /status to confirm provider_auth: present."].join("\n"),
    };
  }

  if (/^pi-ai\b/i.test(trimmed)) {
    return {
      ok: false,
      output: "",
      error: "Unsupported pi-ai command. Use: /exec pi-ai login openai-codex",
    };
  }

  return runBashLike(command, workspace);
}

function runBashLike(command: string, workspace: Workspace): RunResult {
  const trimmed = command.trim();
  if (!trimmed) return { ok: true, output: "" };

  if (trimmed === "pwd") return { ok: true, output: WORKSPACE_ROOT };
  if (trimmed === "ls") return { ok: true, output: workspace.list().join("\n") || "" };
  if (trimmed.startsWith("cat ")) {
    const path = trimmed.slice(4).trim();
    return { ok: true, output: workspace.read(path) };
  }

  const envBanner = `HOME=${WORKSPACE_ROOT}\nXDG_CONFIG_HOME=${WORKSPACE_ROOT}/.config\nXDG_CACHE_HOME=${WORKSPACE_ROOT}/.cache`;
  return {
    ok: true,
    output: `${envBanner}\nSimulated bash execution:\n$ ${trimmed}`,
  };
}
