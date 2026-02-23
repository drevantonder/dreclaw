import { DEFAULT_MODEL, VFS_ROOT, type Env, type SessionRequest, type SessionResponse } from "./types";
import { finishRun, startRun, upsertSessionMeta } from "./db";
import { loadCredentialMap, upsertCredential, type CredentialMap } from "./auth-store";
import { R2FilesystemService } from "./filesystem";
import { getModel, type ModelMessage } from "./model";
import { getOAuthApiKey } from "./oauth";
import { runTool, SessionShell } from "./tools";
import { fetchImageAsDataUrl } from "./telegram";

interface SessionState {
  history: Array<{ role: "user" | "assistant"; content: string }>;
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
    description: "Run shell command in /workspace",
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
  private fs: R2FilesystemService | null = null;
  private shell: SessionShell | null = null;
  private authMap: CredentialMap | null = null;

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

  private getFilesystem(sessionId: string): R2FilesystemService {
    if (!this.fs) this.fs = new R2FilesystemService(this.env.WORKSPACE_BUCKET, sessionId);
    return this.fs;
  }

  private getShell(sessionId: string): SessionShell {
    if (!this.shell) this.shell = new SessionShell(this.getFilesystem(sessionId));
    return this.shell;
  }

  private async handleMessage(payload: SessionRequest, sessionId: string): Promise<SessionResponse> {
    const userText = payload.message.text ?? payload.message.caption ?? "";
    const imageBlocks = await this.loadImages(payload.message);
    const text = userText.trim();
    const shell = this.getShell(sessionId);

    if (text.startsWith("/reset")) {
      this.stateData = { history: [] };
      await this.save();
      await upsertSessionMeta(this.env.DRECLAW_DB, sessionId, payload.message.chat.id, DEFAULT_MODEL, await this.workerAuthReady());
      return { ok: true, text: "Session reset. Context cleared." };
    }

    if (text.startsWith("/status")) {
      const authReady = await this.workerAuthReady();
      const files = await this.getFilesystem(sessionId).list(VFS_ROOT);
      const summary = [
        `model: ${DEFAULT_MODEL}`,
        "session: healthy",
        `workspace: ${VFS_ROOT}`,
        `workspace_files: ${files.length}`,
        `provider_auth: ${authReady ? "present" : "missing"}`,
        `history_messages: ${this.stateData.history.length}`,
      ].join("\n");
      await upsertSessionMeta(this.env.DRECLAW_DB, sessionId, payload.message.chat.id, DEFAULT_MODEL, authReady);
      return { ok: true, text: summary };
    }

    const authMap = await this.getAuthMap();
    const auth = this.env.OPENAI_API_KEY
      ? { apiKey: this.env.OPENAI_API_KEY }
      : await getOAuthApiKey("openai-codex", authMap);
    if ("updated" in auth && auth.updated) {
      this.authMap = await upsertCredential(this.env.AUTH_KV, authMap, auth.updated);
    }

    const finalText = await this.runAgentLoop(shell, auth.apiKey, text, imageBlocks);
    this.stateData.history.push({ role: "user", content: text || "[image]" });
    this.stateData.history.push({ role: "assistant", content: finalText });
    if (this.stateData.history.length > 24) this.stateData.history = this.stateData.history.slice(-24);

    await this.save();
    await upsertSessionMeta(this.env.DRECLAW_DB, sessionId, payload.message.chat.id, DEFAULT_MODEL, true);
    return { ok: true, text: finalText };
  }

  private async runAgentLoop(shell: SessionShell, apiKey: string, userText: string, imageBlocks: string[]): Promise<string> {
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

      messages.push({
        role: "assistant",
        content: completion.text || "",
        tool_calls: completion.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: {
            name: call.name,
            arguments: call.rawArguments,
          },
        })),
      });

      for (const call of completion.toolCalls) {
        const result = await runTool({ name: call.name, args: call.args }, { shell });
        const toolResponse = [
          `tool=${call.name}`,
          `ok=${result.ok ? "true" : "false"}`,
          result.error ? `error=${result.error}` : "",
          `output=${result.output || ""}`,
        ]
          .filter(Boolean)
          .join("\n");

        messages.push({ role: "tool", content: toolResponse, tool_call_id: call.id });

        if (!result.ok) {
          console.error("tool-call-failed", { tool: call.name, error: result.error });
        }
      }
    }

    return "Reached tool loop limit.";
  }

  private async loadImages(message: SessionRequest["message"]): Promise<string[]> {
    if (!message.photo?.length) return [];
    const sorted = [...message.photo].sort((a, b) => (b.file_size ?? 0) - (a.file_size ?? 0));
    const best = sorted[0];
    const dataUrl = await fetchImageAsDataUrl(this.env.TELEGRAM_BOT_TOKEN, best.file_id);
    return dataUrl ? [dataUrl] : [];
  }

  private async getAuthMap(): Promise<CredentialMap> {
    if (this.authMap) return this.authMap;
    this.authMap = await loadCredentialMap(this.env.AUTH_KV);
    return this.authMap;
  }

  private async workerAuthReady(): Promise<boolean> {
    if (this.env.OPENAI_API_KEY) return true;
    const map = await this.getAuthMap();
    return Boolean(map["openai-codex"]?.accessToken);
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
