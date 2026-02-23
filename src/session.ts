import { DEFAULT_MODEL, WORKSPACE_ROOT, type Env, type SessionRequest, type SessionResponse } from "./types";
import { finishRun, getCredentialMap, startRun, upsertCredential, upsertSessionMeta } from "./db";
import { getModel, type ModelMessage } from "./model";
import { getOAuthApiKey, normalizeImportedCredential } from "./oauth";
import { runToolInSandbox } from "./tools";
import { fetchImageAsDataUrl } from "./telegram";
import { getSandbox, type SandboxClient } from "@cloudflare/sandbox";

interface SessionState {
  history: Array<{ role: "user" | "assistant"; content: string }>;
  persistedReady?: boolean;
}

const TOOL_SPECS = [
  {
    name: "read",
    description: "Read file content from active workspace",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "write",
    description: "Write file content to active workspace",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "edit",
    description: "Replace text within a file",
    parameters: {
      type: "object",
      properties: { path: { type: "string" }, find: { type: "string" }, replace: { type: "string" } },
      required: ["path", "find", "replace"],
      additionalProperties: false,
    },
  },
  {
    name: "bash",
    description: "Run shell command in /root/dreclaw",
    parameters: {
      type: "object",
      properties: { command: { type: "string" } },
      required: ["command"],
      additionalProperties: false,
    },
  },
] as const;

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
    if (request.method !== "POST") return new Response("Method not allowed", { status: 405 });

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
      await upsertSessionMeta(this.env.DRECLAW_DB, sessionId, payload.message.chat.id, DEFAULT_MODEL, await this.workerAuthReady());
      return { ok: true, text: "Session reset. Context cleared." };
    }

    if (text.startsWith("/status")) {
      const summary = [
        `model: ${DEFAULT_MODEL}`,
        "session: healthy",
        `workspace: ${WORKSPACE_ROOT}`,
        `persist_sync: ${this.stateData.persistedReady ? "ready" : "degraded"}`,
        `provider_auth: ${(await this.workerAuthReady()) ? "present" : "missing"}`,
        `history_messages: ${this.stateData.history.length}`,
      ].join("\n");
      await upsertSessionMeta(this.env.DRECLAW_DB, sessionId, payload.message.chat.id, DEFAULT_MODEL, await this.workerAuthReady());
      return { ok: true, text: summary };
    }

    if (text.startsWith("/exec ")) {
      const command = text.slice(6).trim();
      const authCommand = await this.handleOwnerAuthCommand(command, sessionId, payload.message.chat.id);
      if (authCommand) return authCommand;

      const result = await this.execInSandbox(command, sandbox);
      await this.checkpointSync(sandbox);
      await upsertSessionMeta(this.env.DRECLAW_DB, sessionId, payload.message.chat.id, DEFAULT_MODEL, await this.workerAuthReady());
      if (result.ok) return { ok: true, text: result.output || "" };
      return { ok: false, text: result.output || `exec error: ${result.error}` };
    }

    const credentials = await getCredentialMap(this.env.DRECLAW_DB);
    const auth = this.env.OPENAI_API_KEY
      ? { apiKey: this.env.OPENAI_API_KEY }
      : await getOAuthApiKey("openai-codex", credentials);
    if ("updated" in auth && auth.updated) await upsertCredential(this.env.DRECLAW_DB, auth.updated);

    this.stateData.history.push({ role: "user", content: text || "[image]" });
    const finalText = await this.runAgentLoop(sandbox, auth.apiKey, text, imageBlocks);
    this.stateData.history.push({ role: "assistant", content: finalText });
    if (this.stateData.history.length > 24) this.stateData.history = this.stateData.history.slice(-24);

    await this.save();
    await this.checkpointSync(sandbox);
    await upsertSessionMeta(this.env.DRECLAW_DB, sessionId, payload.message.chat.id, DEFAULT_MODEL, true);
    return { ok: true, text: finalText };
  }

  private async runAgentLoop(
    sandbox: SandboxClient,
    apiKey: string,
    userText: string,
    imageBlocks: string[],
  ): Promise<string> {
    const model = getModel("openai-codex", DEFAULT_MODEL);
    const messages: ModelMessage[] = buildModelMessages(this.stateData.history, userText, imageBlocks);

    for (let i = 0; i < 6; i += 1) {
      const completion = await model.complete({
        apiKey,
        apiBaseUrl: this.env.OPENAI_API_BASE_URL,
        messages,
        tools: [...TOOL_SPECS],
      });

      if (!completion.toolCalls.length) {
        const text = completion.text.trim();
        return text || "(empty response)";
      }

      for (const call of completion.toolCalls) {
        const result = await runToolInSandbox({ name: call.name, args: call.args }, sandbox);
        const toolResponse = [
          `tool=${call.name}`,
          `ok=${result.ok ? "true" : "false"}`,
          result.error ? `error=${result.error}` : "",
          `output=${result.output || ""}`,
        ]
          .filter(Boolean)
          .join("\n");

        messages.push({ role: "assistant", content: completion.text || `Calling ${call.name}` });
        messages.push({ role: "tool", content: toolResponse, tool_call_id: call.id });

        if (!result.ok) {
          console.error("tool-call-failed", { tool: call.name, error: result.error });
        }
      }
    }

    return "Reached tool loop limit.";
  }

  private async handleOwnerAuthCommand(command: string, sessionId: string, chatId: number): Promise<SessionResponse | null> {
    if (!command.startsWith("auth ")) return null;

    if (command === "auth status") {
      const ready = await this.workerAuthReady();
      await upsertSessionMeta(this.env.DRECLAW_DB, sessionId, chatId, DEFAULT_MODEL, ready);
      return { ok: true, text: `Worker auth store: ${ready ? "ready" : "missing"}` };
    }

    if (command.startsWith("auth import ")) {
      const encoded = command.slice("auth import ".length).trim();
      if (!encoded) return { ok: false, text: "Usage: /exec auth import <base64-json>" };

      const json = decodeBase64Url(encoded);
      const credential = normalizeImportedCredential(JSON.parse(json));
      await upsertCredential(this.env.DRECLAW_DB, credential);
      return { ok: true, text: `Imported credential for ${credential.provider}.` };
    }

    return { ok: false, text: "Unknown auth command. Use /exec auth status or /exec auth import <base64-json>." };
  }

  private async loadImages(message: SessionRequest["message"]): Promise<string[]> {
    if (!message.photo?.length) return [];
    const sorted = [...message.photo].sort((a, b) => (b.file_size ?? 0) - (a.file_size ?? 0));
    const best = sorted[0];
    const dataUrl = await fetchImageAsDataUrl(this.env.TELEGRAM_BOT_TOKEN, best.file_id);
    return dataUrl ? [dataUrl] : [];
  }

  private async workerAuthReady(): Promise<boolean> {
    if (this.env.OPENAI_API_KEY) return true;
    const map = await getCredentialMap(this.env.DRECLAW_DB);
    return Boolean(map["openai-codex"]?.accessToken);
  }

  private async execInSandbox(command: string, sandbox: SandboxClient): Promise<{ ok: boolean; output: string; error?: string }> {
    if (!command.trim()) return { ok: true, output: "" };
    const result = await sandbox.exec(`bash -lc ${shellQuote(command)}`, { cwd: WORKSPACE_ROOT, env: sandboxEnv() });
    const merged = [result.stdout ?? "", result.stderr ?? ""].filter(Boolean).join("\n").trim();
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
    if (!mounted) return;

    const restore = await sandbox.exec("bash -lc 'mkdir -p /persist/dreclaw /root/dreclaw && cp -a /persist/dreclaw/. /root/dreclaw/ 2>/dev/null || true'", {
      cwd: WORKSPACE_ROOT,
      env: sandboxEnv(),
    });
    this.stateData.persistedReady = restore.success;
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

function buildModelMessages(
  history: Array<{ role: "user" | "assistant"; content: string }>,
  userText: string,
  imageBlocks: string[],
): ModelMessage[] {
  const messages: ModelMessage[] = [
    {
      role: "system",
      content:
        "You are dreclaw strict v0. Use tools only when needed. Return concise final answers. Do not echo user text. Use bash/read/write/edit only through tool calls.",
    },
  ];

  for (const item of history.slice(-10)) {
    messages.push({ role: item.role, content: item.content });
  }

  const content: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> = [
    { type: "text", text: userText || "[image message]" },
  ];
  for (const image of imageBlocks) {
    content.push({ type: "image_url", image_url: { url: image } });
  }

  messages.push({ role: "user", content });
  return messages;
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

function decodeBase64Url(value: string): string {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const pad = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  return atob(normalized + pad);
}
