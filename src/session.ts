import { DEFAULT_MODEL, WORKSPACE_ROOT, type Env, type SessionRequest, type SessionResponse } from "./types";
import { finishRun, startRun, upsertSessionMeta } from "./db";
import { extractToolCall, runToolInSandbox } from "./tools";
import { fetchImageAsDataUrl } from "./telegram";
import { getSandbox, type SandboxClient } from "@cloudflare/sandbox";

interface SessionState {
  history: Array<{ role: "user" | "assistant" | "tool"; content: string }>;
  persistedReady?: boolean;
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
    const sandbox = getSandbox(this.env.SANDBOX, `session-${payload.message.chat.id}`);
    await this.ensureSandboxReady(sandbox, sessionId);

    const userText = payload.message.text ?? payload.message.caption ?? "";
    const imageBlocks = await this.loadImages(payload.message);
    const text = userText.trim();

    if (text.startsWith("/reset")) {
      this.stateData = { history: [] };
      await this.save();
      await this.checkpointSync(sandbox);
      await upsertSessionMeta(this.env.DRECLAW_DB, sessionId, payload.message.chat.id, DEFAULT_MODEL, await this.sandboxAuthReady(sandbox));
      return { ok: true, text: "Session reset. Context cleared." };
    }

    if (text.startsWith("/status")) {
      const authReady = await this.sandboxAuthReady(sandbox);
      const summary = [
        `model: ${DEFAULT_MODEL}`,
        "session: healthy",
        `workspace: ${WORKSPACE_ROOT}`,
        `persist_sync: ${this.stateData.persistedReady ? "ready" : "degraded"}`,
        `provider_auth: ${authReady ? "present" : "missing"}`,
        `history_messages: ${this.stateData.history.length}`,
      ].join("\n");
      await upsertSessionMeta(this.env.DRECLAW_DB, sessionId, payload.message.chat.id, DEFAULT_MODEL, authReady);
      return { ok: true, text: summary };
    }

    if (text.startsWith("/tool ")) {
      return { ok: false, text: "`/tool` is disabled in strict v0. Tools are model-internal only." };
    }

    if (text.startsWith("/exec ")) {
      const command = text.slice(6).trim();
      const result = await this.execInSandbox(command, sandbox);
      await this.checkpointSync(sandbox);
      const authReady = await this.sandboxAuthReady(sandbox);
      await upsertSessionMeta(this.env.DRECLAW_DB, sessionId, payload.message.chat.id, DEFAULT_MODEL, authReady);
      if (result.ok) return { ok: true, text: result.output || "" };
      return { ok: false, text: result.output || `exec error: ${result.error}` };
    }

    this.stateData.history.push({ role: "user", content: text || "[image]" });
    const finalText = await this.runAgentLoop(text, imageBlocks, sandbox);
    this.stateData.history.push({ role: "assistant", content: finalText });
    if (this.stateData.history.length > 20) this.stateData.history = this.stateData.history.slice(-20);

    await this.save();
    await this.checkpointSync(sandbox);
    await upsertSessionMeta(this.env.DRECLAW_DB, sessionId, payload.message.chat.id, DEFAULT_MODEL, await this.sandboxAuthReady(sandbox));
    return { ok: true, text: finalText };
  }

  private async runAgentLoop(text: string, imageBlocks: string[], sandbox: SandboxClient): Promise<string> {
    if (!(await this.sandboxAuthReady(sandbox))) {
      return ["Auth not ready for provider-backed pi-ai.", "Run: /exec pi-ai login openai-codex"].join("\n");
    }

    let latest = text;
    for (let i = 0; i < 6; i += 1) {
      const modelOutput = await this.invokeModel(sandbox, latest, imageBlocks);
      const toolCall = extractToolCall(modelOutput);
      if (!toolCall) return sanitizeModelOutput(modelOutput);

      const result = await runToolInSandbox(toolCall, sandbox);
      this.stateData.history.push({ role: "assistant", content: modelOutput });
      this.stateData.history.push({
        role: "tool",
        content: [`Tool: ${toolCall.name}`, result.ok ? "Status: ok" : `Status: error (${result.error ?? "unknown"})`, `Output:\n${result.output || "(empty)"}`].join("\n"),
      });
      if (!result.ok) return `Tool ${toolCall.name} failed: ${result.error ?? "unknown"}`;
      latest = `Tool ${toolCall.name} succeeded.`;
    }

    return "Reached tool loop limit.";
  }

  private async invokeModel(sandbox: SandboxClient, userText: string, imageBlocks: string[]): Promise<string> {
    const prompt = buildPrompt(this.stateData.history, userText, imageBlocks);
    await sandbox.writeFile("/tmp/dreclaw_prompt.txt", prompt);

    const command = [
      "set -eo pipefail",
      "MODEL='openai/gpt-5.3-codex'",
      "if pi-ai chat --model \"$MODEL\" < /tmp/dreclaw_prompt.txt; then exit 0; fi",
      "if pi-ai --model \"$MODEL\" < /tmp/dreclaw_prompt.txt; then exit 0; fi",
      "pi-ai < /tmp/dreclaw_prompt.txt",
    ].join("; ");

    const result = await sandbox.exec(`bash -lc ${shellQuote(command)}`, {
      cwd: WORKSPACE_ROOT,
      env: sandboxEnv(),
    });
    const output = [result.stdout ?? "", result.stderr ?? ""].filter(Boolean).join("\n").trim();
    if (!result.success) throw new Error(output || "pi-ai inference failed");
    return output;
  }

  private async loadImages(message: SessionRequest["message"]): Promise<string[]> {
    if (!message.photo?.length) return [];
    const sorted = [...message.photo].sort((a, b) => (b.file_size ?? 0) - (a.file_size ?? 0));
    const best = sorted[0];
    const dataUrl = await fetchImageAsDataUrl(this.env.TELEGRAM_BOT_TOKEN, best.file_id);
    return dataUrl ? [dataUrl] : [];
  }

  private async sandboxAuthReady(sandbox: SandboxClient): Promise<boolean> {
    try {
      const state = await sandbox.exists(`${WORKSPACE_ROOT}/.pi-ai/auth.json`);
      return Boolean(state.exists);
    } catch {
      return false;
    }
  }

  private async execInSandbox(command: string, sandbox: SandboxClient): Promise<{ ok: boolean; output: string; error?: string }> {
    if (!command.trim()) return { ok: true, output: "" };
    const result = await sandbox.exec(`bash -lc ${shellQuote(command)}`, { cwd: WORKSPACE_ROOT, env: sandboxEnv() });
    const stdout = result.stdout ?? "";
    const stderr = result.stderr ?? "";
    const merged = [stdout, stderr].filter(Boolean).join("\n").trim();
    if (result.success) return { ok: true, output: merged };
    const exitCode = typeof result.exitCode === "number" ? ` (exit ${result.exitCode})` : "";
    return { ok: false, output: merged || `Command failed${exitCode}`, error: `Command failed${exitCode}` };
  }

  private async ensureSandboxReady(sandbox: SandboxClient, sessionId: string): Promise<void> {
    await sandbox.exec("bash -lc 'mkdir -p /root/dreclaw /root/dreclaw/.config /root/dreclaw/.cache /persist /persist/dreclaw'", {
      cwd: WORKSPACE_ROOT,
      env: sandboxEnv(),
    });

    const mounted = await this.mountPersistIfConfigured(sandbox, sessionId);
    if (mounted) {
      const restore = await sandbox.exec("bash -lc 'mkdir -p /persist/dreclaw /root/dreclaw && cp -a /persist/dreclaw/. /root/dreclaw/ 2>/dev/null || true'", {
        cwd: WORKSPACE_ROOT,
        env: sandboxEnv(),
      });
      this.stateData.persistedReady = restore.success;
    }
  }

  private async checkpointSync(sandbox: SandboxClient): Promise<void> {
    if (!this.stateData.persistedReady) return;
    await sandbox.exec("bash -lc 'mkdir -p /persist/dreclaw && cp -a /root/dreclaw/. /persist/dreclaw/ 2>/dev/null || true'", {
      cwd: WORKSPACE_ROOT,
      env: sandboxEnv(),
    });
  }

  private async mountPersistIfConfigured(sandbox: SandboxClient, sessionId: string): Promise<boolean> {
    if (this.stateData.persistedReady) return true;

    const endpoint = this.env.R2_ENDPOINT;
    const accessKeyId = this.env.R2_ACCESS_KEY_ID;
    const secretAccessKey = this.env.R2_SECRET_ACCESS_KEY;
    const bucketName = this.env.WORKSPACE_BUCKET_NAME;
    if (!endpoint || !accessKeyId || !secretAccessKey || !bucketName) {
      console.warn("persist-mount-config-missing", { sessionId });
      this.stateData.persistedReady = false;
      return false;
    }

    try {
      await sandbox.mountBucket(bucketName, "/persist", {
        endpoint,
        provider: "r2",
        credentials: { accessKeyId, secretAccessKey },
      });
      this.stateData.persistedReady = true;
      return true;
    } catch (error) {
      console.error("persist-mount-failed", { sessionId, message: error instanceof Error ? error.message : "unknown" });
      this.stateData.persistedReady = false;
      return false;
    }
  }
}

function shellQuote(input: string): string {
  return `'${input.replace(/'/g, `'"'"'`)}'`;
}

function sandboxEnv(): Record<string, string> {
  return {
    HOME: WORKSPACE_ROOT,
    XDG_CONFIG_HOME: `${WORKSPACE_ROOT}/.config`,
    XDG_CACHE_HOME: `${WORKSPACE_ROOT}/.cache`,
  };
}

function buildPrompt(
  history: Array<{ role: "user" | "assistant" | "tool"; content: string }>,
  userText: string,
  imageBlocks: string[],
): string {
  const recent = history.slice(-10).map((item) => `${item.role.toUpperCase()}: ${item.content}`).join("\n\n");
  const imageText = imageBlocks.map((img, idx) => `image_${idx + 1}: ${img.slice(0, 12000)}${img.length > 12000 ? "..." : ""}`).join("\n");

  return [
    "You are dreclaw running strict v0.",
    "Use tools only by returning strict JSON when needed:",
    '{"tool":{"name":"read|write|edit|bash","args":{...}}}',
    "If no tool needed, return final user-facing text only.",
    "Do not echo user input.",
    `Model: ${DEFAULT_MODEL}`,
    recent ? `History:\n${recent}` : "History: (empty)",
    `User:\n${userText || "[no text]"}`,
    imageText ? `Images:\n${imageText}` : "Images: none",
  ].join("\n\n");
}

function sanitizeModelOutput(output: string): string {
  const trimmed = output.trim();
  return trimmed || "(empty response)";
}
