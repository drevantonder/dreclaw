import { DEFAULT_BASE_URL, VFS_ROOT, type Env, type SessionRequest, type SessionResponse } from "./types";
import { finishRun, startRun, upsertSessionMeta } from "./db";
import { R2FilesystemService } from "./filesystem";
import { getModel, type ModelMessage } from "./model";
import { TOOL_SPECS } from "./tool-schema";
import { runTool, SessionShell } from "./tools";
import { fetchImageAsDataUrl } from "./telegram";

interface SessionState {
  history: Array<{ role: "user" | "assistant"; content: string }>;
}

interface RuntimeConfig {
  model: string;
  baseUrl: string;
  apiKey: string;
}

export class SessionRuntime implements DurableObject {
  private readonly state: DurableObjectState;
  private readonly env: Env;
  private loaded = false;
  private stateData: SessionState = { history: [] };
  private fs: R2FilesystemService | null = null;
  private shell: SessionShell | null = null;

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
      const message = compactErrorMessage(error);
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
      await upsertSessionMeta(this.env.DRECLAW_DB, sessionId, payload.message.chat.id, this.getModelName(), await this.workerAuthReady());
      return { ok: true, text: "Session reset. Context cleared." };
    }

    if (text.startsWith("/status")) {
      const authReady = await this.workerAuthReady();
      const files = await this.getFilesystem(sessionId).list(VFS_ROOT);
      const summary = [
        `model: ${this.getModelName()}`,
        "session: healthy",
        `workspace: ${VFS_ROOT}`,
        `workspace_files: ${files.length}`,
        `provider_auth: ${authReady ? "present" : "missing"}`,
        `history_messages: ${this.stateData.history.length}`,
      ].join("\n");
      await upsertSessionMeta(this.env.DRECLAW_DB, sessionId, payload.message.chat.id, this.getModelName(), authReady);
      return { ok: true, text: summary };
    }

    const runtime = this.getRuntimeConfig();

    const finalText = await this.runAgentLoop(shell, runtime, text, imageBlocks);
    this.stateData.history.push({ role: "user", content: text || "[image]" });
    this.stateData.history.push({ role: "assistant", content: finalText });
    if (this.stateData.history.length > 24) this.stateData.history = this.stateData.history.slice(-24);

    await this.save();
    await upsertSessionMeta(this.env.DRECLAW_DB, sessionId, payload.message.chat.id, runtime.model, true);
    return { ok: true, text: finalText };
  }

  private async runAgentLoop(shell: SessionShell, runtime: RuntimeConfig, userText: string, imageBlocks: string[]): Promise<string> {
    let activeModel = runtime.model;
    const fallbackModel = resolveFallbackModel(runtime.model);
    const messages: ModelMessage[] = buildModelMessages(this.stateData.history, userText, imageBlocks);

    for (let i = 0; i < 6; i += 1) {
      let completion;
      try {
        completion = await getModel(activeModel).complete({
          apiKey: runtime.apiKey,
          messages,
          tools: [...TOOL_SPECS],
          baseUrl: runtime.baseUrl,
          transport: "sse",
        });
      } catch (error) {
        if (fallbackModel && activeModel !== fallbackModel && isRateLimitError(error)) {
          console.warn("model-rate-limited-fallback", { from: activeModel, to: fallbackModel });
          activeModel = fallbackModel;
          completion = await getModel(activeModel).complete({
            apiKey: runtime.apiKey,
            messages,
            tools: [...TOOL_SPECS],
            baseUrl: runtime.baseUrl,
            transport: "sse",
          });
        } else {
          throw error;
        }
      }

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

  private async workerAuthReady(): Promise<boolean> {
    return Boolean(this.env.OPENCODE_ZEN_API_KEY?.trim());
  }

  private getRuntimeConfig(): RuntimeConfig {
    const model = this.getModelName();

    const apiKey = this.env.OPENCODE_ZEN_API_KEY?.trim();
    if (!apiKey) throw new Error("Missing OPENCODE_ZEN_API_KEY");

    const baseUrl = this.env.BASE_URL?.trim() || DEFAULT_BASE_URL;
    return { model, apiKey, baseUrl };
  }

  private getModelName(): string {
    const model = this.env.MODEL?.trim();
    if (!model) throw new Error("Missing MODEL");
    return model;
  }
}

function isRateLimitError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message.includes("429") || message.toLowerCase().includes("rate limit");
}

function resolveFallbackModel(model: string): string | null {
  if (!model.includes("-free")) return null;
  return model.replace(/-free$/i, "");
}

function compactErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unexpected runtime error";
  const compact = message.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  if (!compact) return "Unexpected runtime error";
  if (compact.length <= 320) return compact;
  return `${compact.slice(0, 319)}…`;
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
        "You are dreclaw strict v0. Use tools only when needed. Return concise final answers. Do not echo user text. Use bash/read/write/edit only through tool calls. Proactively use /memory for durable, decision-useful context: read it when useful, write/update .md files when important new context appears, keep it clean by merging duplicates/removing stale info, and never store secrets or credentials.",
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
