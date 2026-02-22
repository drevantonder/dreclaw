import { DEFAULT_MODEL, WORKSPACE_ROOT, type Env, type SessionRequest, type SessionResponse } from "./types";
import { finishRun, startRun, upsertSessionMeta } from "./db";
import { parseToolCall, runTool } from "./tools";
import { Workspace } from "./workspace";
import { fetchImageAsDataUrl } from "./telegram";
import { getSandbox } from "@cloudflare/sandbox";

interface SessionState {
  history: Array<{ role: "user" | "assistant"; content: string }>;
}

export class SessionRuntime implements DurableObject {
  private readonly state: DurableObjectState;
  private readonly env: Env;
  private loaded = false;
  private stateData: SessionState = { history: [] };

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    await this.load();
    const payload = (await request.json()) as SessionRequest;
    const sessionId = this.state.id.toString();
    const runId = crypto.randomUUID();
    await startRun(this.env.DRECLAW_DB, runId, sessionId);

    try {
      const response = await this.handleMessage(payload, sessionId);
      await finishRun(this.env.DRECLAW_DB, runId);
      return Response.json(response);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unexpected runtime error";
      console.error("session-run-failed", { sessionId, message });
      await finishRun(this.env.DRECLAW_DB, runId, message);
      return Response.json({ ok: false, text: `Failed: ${message}` } satisfies SessionResponse);
    }
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.stateData = (await this.state.storage.get<SessionState>("session-state")) ?? { history: [] };
    this.loaded = true;
  }

  private async save(): Promise<void> {
    await this.state.storage.put("session-state", this.stateData);
  }

  private async handleMessage(payload: SessionRequest, sessionId: string): Promise<SessionResponse> {
    const workspace = new Workspace(this.env.WORKSPACE_BUCKET, sessionId);
    await workspace.restore();
    const sandbox = getSandbox(this.env.SANDBOX, `session-${payload.message.chat.id}`);

    const userText = payload.message.text ?? payload.message.caption ?? "";
    const imageBlocks = await this.loadImages(payload.message);
    const text = userText.trim();

    if (text.startsWith("/reset")) {
      this.stateData = { history: [] };
      await this.save();
      await workspace.checkpoint();
      await upsertSessionMeta(this.env.DRECLAW_DB, sessionId, payload.message.chat.id, DEFAULT_MODEL, workspace.authReady());
      return { ok: true, text: "Session reset. Context cleared." };
    }

    if (text.startsWith("/status")) {
      const authReady = await this.sandboxAuthReady(sandbox);
      const summary = [
        `model: ${DEFAULT_MODEL}`,
        `session: healthy`,
        `workspace: ${WORKSPACE_ROOT}`,
        `provider_auth: ${authReady ? "present" : "missing"}`,
        `history_messages: ${this.stateData.history.length}`,
      ].join("\n");
      await upsertSessionMeta(this.env.DRECLAW_DB, sessionId, payload.message.chat.id, DEFAULT_MODEL, authReady);
      return { ok: true, text: summary };
    }

    if (text.startsWith("/exec ")) {
      const command = text.slice(6).trim();
      const result = await this.execInSandbox(command, sandbox);
      const authReady = await this.sandboxAuthReady(sandbox);
      await upsertSessionMeta(this.env.DRECLAW_DB, sessionId, payload.message.chat.id, DEFAULT_MODEL, authReady);
      if (result.ok) return { ok: true, text: result.output || "" };
      return { ok: false, text: result.output || `exec error: ${result.error}` };
    }

    this.stateData.history.push({ role: "user", content: text || "[image]" });

    const authReady = await this.sandboxAuthReady(sandbox);
    const finalText = await this.runAgentLoop(text, imageBlocks, workspace, authReady);
    this.stateData.history.push({ role: "assistant", content: finalText });
    if (this.stateData.history.length > 20) {
      this.stateData.history = this.stateData.history.slice(-20);
    }

    await this.save();
    await workspace.checkpoint();
    await upsertSessionMeta(this.env.DRECLAW_DB, sessionId, payload.message.chat.id, DEFAULT_MODEL, authReady);
    return { ok: true, text: finalText };
  }

  private async runAgentLoop(text: string, imageBlocks: string[], workspace: Workspace, authReady: boolean): Promise<string> {
    let workingText = text;
    for (let i = 0; i < 4; i += 1) {
      const toolCall = parseToolCall(workingText);
      if (!toolCall) {
        return this.makeFinalResponse(workingText, imageBlocks, authReady);
      }
      const result = runTool(toolCall, workspace);
      if (!result.ok) {
        return `Tool ${toolCall.name} failed: ${result.error ?? "unknown"}`;
      }
      return `Tool ${toolCall.name} result:\n${result.output}`;
    }
    return "Reached tool loop limit.";
  }

  private makeFinalResponse(text: string, imageBlocks: string[], authReady: boolean): string {
    if (!text && imageBlocks.length > 0) {
      return `Received ${imageBlocks.length} image(s). Ask me to inspect one using /tool read|write|edit|bash as needed.`;
    }
    if (!authReady) {
      return [
        "Auth not ready for provider-backed pi-ai.",
        "Run: /exec pi-ai login openai-codex",
        `Echo: ${text || "(empty message)"}`,
      ].join("\n");
    }
    return `(${DEFAULT_MODEL}) ${text || "Ready."}`;
  }

  private async loadImages(message: SessionRequest["message"]): Promise<string[]> {
    if (!message.photo?.length) return [];
    const sorted = [...message.photo].sort((a, b) => (b.file_size ?? 0) - (a.file_size ?? 0));
    const best = sorted[0];
    const dataUrl = await fetchImageAsDataUrl(this.env.TELEGRAM_BOT_TOKEN, best.file_id);
    return dataUrl ? [dataUrl] : [];
  }

  private async sandboxAuthReady(sandbox: ReturnType<typeof getSandbox>): Promise<boolean> {
    try {
      await sandbox.readFile(`${WORKSPACE_ROOT}/.pi-ai/auth.json`);
      return true;
    } catch {
      return false;
    }
  }

  private async execInSandbox(
    command: string,
    sandbox: ReturnType<typeof getSandbox>,
  ): Promise<{ ok: boolean; output: string; error?: string }> {
    if (!command.trim()) return { ok: true, output: "" };

    const wrapped = [
      "mkdir -p /root/dreclaw /root/dreclaw/.config /root/dreclaw/.cache",
      "export HOME=/root/dreclaw XDG_CONFIG_HOME=/root/dreclaw/.config XDG_CACHE_HOME=/root/dreclaw/.cache",
      "cd /root/dreclaw",
      command,
    ].join("; ");

    const result = await sandbox.exec(`bash -lc ${shellQuote(wrapped)}`);
    const stdout = result.stdout ?? "";
    const stderr = result.stderr ?? "";
    const merged = [stdout, stderr].filter(Boolean).join("\n").trim();

    if (result.success) return { ok: true, output: merged };

    const exitCode = typeof result.exitCode === "number" ? ` (exit ${result.exitCode})` : "";
    return {
      ok: false,
      output: merged || `Command failed${exitCode}`,
      error: `Command failed${exitCode}`,
    };
  }
}

function shellQuote(input: string): string {
  return `'${input.replace(/'/g, `'"'"'`)}'`;
}
