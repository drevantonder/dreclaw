import { DEFAULT_BASE_URL, VFS_ROOT, type Env, type ProgressMode, type SessionRequest, type SessionResponse } from "./types";
import { finishRun, startRun, upsertSessionMeta } from "./db";
import { R2FilesystemService } from "./filesystem";
import { getModel, type ModelMessage } from "./model";
import { TOOL_SPECS } from "./tool-schema";
import { runTool, SessionShell } from "./tools";
import { editTelegramMessage, fetchImageAsDataUrl, sendTelegramMessage } from "./telegram";

type SessionHistoryEntry = { role: "user" | "assistant" | "tool"; content: string };

interface SessionState {
  history: SessionHistoryEntry[];
  prefs?: {
    progressMode?: ProgressMode;
    showThinking?: boolean;
  };
}

interface RuntimeConfig {
  model: string;
  baseUrl: string;
  apiKey: string;
}

interface AgentRunResult {
  finalText: string;
  toolErrors: string[];
  toolEvents: ToolEvent[];
}

interface ToolEvent {
  name: string;
  ok: boolean;
  detail: string;
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
      this.pushHistory({ role: "assistant", content: `Failed: ${message}` });
      await this.save();
      await finishRun(this.env.DRECLAW_DB, runId, message);
      return Response.json({ ok: false, text: `Failed: ${message}` } satisfies SessionResponse);
    }
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.stateData = (await this.state.storage.get<SessionState>("session-state")) ?? { history: [] };
    this.stateData.prefs = normalizePrefs(this.stateData.prefs);
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
      this.stateData = { history: [], prefs: normalizePrefs(this.stateData.prefs) };
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

    if (text.startsWith("/details")) {
      const nextMode = parseDetailsMode(text);
      if (!nextMode) {
        const current = this.getProgressMode();
        return { ok: true, text: `details: ${current}\nusage: /details compact|verbose|debug` };
      }
      this.stateData.prefs = {
        ...normalizePrefs(this.stateData.prefs),
        progressMode: nextMode,
      };
      await this.save();
      return { ok: true, text: `details set to ${nextMode}.` };
    }

    if (text.startsWith("/thinking")) {
      const nextThinking = parseThinkingFlag(text);
      if (nextThinking === null) {
        const current = this.shouldShowThinking() ? "on" : "off";
        return { ok: true, text: `thinking: ${current}\nusage: /thinking on|off` };
      }
      this.stateData.prefs = {
        ...normalizePrefs(this.stateData.prefs),
        showThinking: nextThinking,
      };
      await this.save();
      return { ok: true, text: `thinking ${nextThinking ? "enabled" : "disabled"}.` };
    }

    const runtime = this.getRuntimeConfig();
    const progress = new TelegramProgressReporter({
      token: this.env.TELEGRAM_BOT_TOKEN,
      chatId: payload.message.chat.id,
      mode: this.getProgressMode(),
      statusMessageId: payload.progressMessageId,
      showThinking: this.shouldShowThinking(),
    });

    const run = await this.runAgentLoop(shell, runtime, text, imageBlocks, progress);
    const responseText = formatUserFacingResponse(run.finalText, run.toolEvents);
    this.pushHistory({ role: "user", content: text || "[image]" });
    for (const toolError of run.toolErrors) {
      this.pushHistory({ role: "tool", content: toolError });
    }
    this.pushHistory({ role: "assistant", content: responseText });

    await this.save();
    await upsertSessionMeta(this.env.DRECLAW_DB, sessionId, payload.message.chat.id, runtime.model, true);
    return { ok: true, text: responseText };
  }

  private async runAgentLoop(
    shell: SessionShell,
    runtime: RuntimeConfig,
    userText: string,
    imageBlocks: string[],
    progress: TelegramProgressReporter,
  ): Promise<AgentRunResult> {
    let activeModel = runtime.model;
    const fallbackModel = resolveFallbackModel(runtime.model);
    const messages: ModelMessage[] = buildModelMessages(this.stateData.history, userText, imageBlocks);
    const toolErrors: string[] = [];
    const toolEvents: ToolEvent[] = [];

    await progress.setStatus("Working...", true);

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

      for (const block of completion.thinking) {
        await progress.onThinking(block);
      }

      if (!completion.toolCalls.length) {
        const text = completion.text.trim();
        await progress.setStatus("Wrapping up...", true);
        return { finalText: text || "(empty response)", toolErrors, toolEvents };
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
        await progress.onToolStart(call.name, call.args);
        const result = await runTool({ name: call.name, args: call.args }, { shell });
        const toolEvent = buildToolEvent(call.name, result.ok, result.output, result.error);
        toolEvents.push(toolEvent);
        const toolResponse = [
          `tool=${call.name}`,
          `ok=${result.ok ? "true" : "false"}`,
          result.error ? `error=${result.error}` : "",
          `output=${result.output || ""}`,
        ]
          .filter(Boolean)
          .join("\n");

        messages.push({ role: "tool", content: toolResponse, tool_call_id: call.id });
        await progress.onToolResult(call.name, result.ok, result.output, result.error);

        if (!result.ok) {
          console.error("tool-call-failed", { tool: call.name, error: result.error });
          toolErrors.push(toolResponse);
        }
      }
    }

    return { finalText: "Reached tool loop limit.", toolErrors, toolEvents };
  }

  private pushHistory(entry: SessionHistoryEntry): void {
    this.stateData.history.push(entry);
    if (this.stateData.history.length > 24) this.stateData.history = this.stateData.history.slice(-24);
  }

  private getProgressMode(): ProgressMode {
    return normalizePrefs(this.stateData.prefs).progressMode;
  }

  private shouldShowThinking(): boolean {
    return normalizePrefs(this.stateData.prefs).showThinking;
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

function buildToolEvent(name: string, ok: boolean, output: string, error?: string): ToolEvent {
  const detail = ok ? truncateForLog(output, 220) : truncateForLog(error || output || "error", 220);
  return { name, ok, detail };
}

function formatUserFacingResponse(finalText: string, toolEvents: ToolEvent[]): string {
  const response = finalText.trim() || "(empty response)";
  if (!toolEvents.length) return response;
  const usedNames = unique(toolEvents.map((event) => event.name));
  const failedNames = unique(toolEvents.filter((event) => !event.ok).map((event) => event.name));
  let suffix = `Tools used: ${usedNames.join(", ")}`;
  if (failedNames.length) {
    suffix += `\nFailed tools: ${failedNames.join(", ")}`;
  }
  return `${response}\n\n${suffix}`;
}

function normalizePrefs(prefs: SessionState["prefs"]): { progressMode: ProgressMode; showThinking: boolean } {
  const progressMode = prefs?.progressMode;
  const showThinking = Boolean(prefs?.showThinking);
  if (progressMode === "compact" || progressMode === "verbose" || progressMode === "debug") {
    return { progressMode, showThinking };
  }
  return { progressMode: "compact", showThinking };
}

function parseDetailsMode(text: string): ProgressMode | null {
  const [, rawMode = ""] = text.trim().split(/\s+/, 2);
  const mode = rawMode.toLowerCase();
  if (!mode) return null;
  if (mode === "off") return "compact";
  if (mode === "on") return "verbose";
  if (mode === "compact" || mode === "verbose" || mode === "debug") return mode;
  return null;
}

function parseThinkingFlag(text: string): boolean | null {
  const [, rawFlag = ""] = text.trim().split(/\s+/, 2);
  const flag = rawFlag.toLowerCase();
  if (!flag) return null;
  if (flag === "on") return true;
  if (flag === "off") return false;
  return null;
}

function unique(items: string[]): string[] {
  return [...new Set(items.filter(Boolean))];
}

class TelegramProgressReporter {
  private static readonly STATUS_THROTTLE_MS = 1500;

  private readonly token: string;
  private readonly chatId: number;
  private readonly mode: ProgressMode;
  private readonly showThinking: boolean;
  private statusMessageId?: number;
  private lastStatusText = "";
  private lastStatusAt = 0;
  private toolStartAtByName = new Map<string, number>();

  constructor(params: {
    token: string;
    chatId: number;
    mode: ProgressMode;
    statusMessageId?: number;
    showThinking: boolean;
  }) {
    this.token = params.token;
    this.chatId = params.chatId;
    this.mode = params.mode;
    this.statusMessageId = params.statusMessageId;
    this.showThinking = params.showThinking;
  }

  async setStatus(text: string, force = false): Promise<void> {
    const next = text.trim();
    if (!next) return;
    const now = Date.now();
    if (!force && next === this.lastStatusText) return;
    if (!force && now - this.lastStatusAt < TelegramProgressReporter.STATUS_THROTTLE_MS) return;

    this.lastStatusText = next;
    this.lastStatusAt = now;
    await this.safeUpdateStatus(next);
  }

  async onThinking(raw: string): Promise<void> {
    await this.setStatus("Analyzing...");
    if (!this.showThinking) return;
    const text = truncateForLog(raw, 500);
    if (!text) return;
    if (this.mode === "debug") {
      await this.safeSendMessage(`Thinking:\n${text}`);
    }
  }

  async onToolStart(name: string, args: Record<string, unknown>): Promise<void> {
    this.toolStartAtByName.set(name, Date.now());
    await this.setStatus(statusTextForTool(name));

    if (this.mode === "verbose") {
      await this.safeSendMessage(`Tool start: ${name}`);
      return;
    }

    if (this.mode === "debug") {
      await this.safeSendMessage(`Tool call: ${name} ${truncateForLog(JSON.stringify(args), 420)}`);
    }
  }

  async onToolResult(name: string, ok: boolean, output: string, error?: string): Promise<void> {
    const startedAt = this.toolStartAtByName.get(name);
    this.toolStartAtByName.delete(name);
    const elapsedMs = startedAt ? Date.now() - startedAt : 0;

    if (!ok) {
      await this.setStatus(`Tool failed: ${name}`, true);
      const detail = truncateForLog(error || output || "error", 700);
      if (this.mode !== "compact") {
        await this.safeSendMessage(`Tool error: ${name}${detail ? ` ${detail}` : ""}`);
      }
      return;
    }

    await this.setStatus("Working...");
    if (this.mode === "verbose") {
      await this.safeSendMessage(`Tool ok: ${name}${elapsedMs >= 3000 ? ` (${Math.round(elapsedMs / 100) / 10}s)` : ""}`);
      return;
    }
    if (this.mode === "debug") {
      const detail = truncateForLog(output, 700);
      await this.safeSendMessage(`Tool ok: ${name}${detail ? ` ${detail}` : ""}`);
      return;
    }
    if (elapsedMs >= 5000) {
      await this.setStatus(`Still working (${name} took ${Math.round(elapsedMs / 1000)}s)...`, true);
    }
  }

  private async safeUpdateStatus(text: string): Promise<void> {
    if (typeof this.statusMessageId === "number") {
      try {
        await editTelegramMessage(this.token, this.chatId, this.statusMessageId, text);
        return;
      } catch (error) {
        console.warn("telegram-progress-edit-failed", {
          chatId: this.chatId,
          messageId: this.statusMessageId,
          error: error instanceof Error ? error.message : String(error ?? "unknown"),
        });
      }
    }

    await this.safeSendMessage(text, true);
  }

  private async safeSendMessage(text: string, assignStatusId = false): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;
    try {
      const messageId = await sendTelegramMessage(this.token, this.chatId, trimmed);
      if (assignStatusId && typeof messageId === "number") {
        this.statusMessageId = messageId;
      }
    } catch (error) {
      console.warn("telegram-progress-send-failed", {
        chatId: this.chatId,
        error: error instanceof Error ? error.message : String(error ?? "unknown"),
      });
    }
  }
}

function statusTextForTool(toolName: string): string {
  if (toolName === "read" || toolName === "glob" || toolName === "grep") {
    return "Reading project...";
  }
  if (toolName === "bash") {
    return "Running command...";
  }
  if (toolName === "write" || toolName === "edit") {
    return "Updating files...";
  }
  return `Running ${toolName}...`;
}

function truncateForLog(input: string, max: number): string {
  const compact = String(input ?? "").replace(/\s+/g, " ").trim();
  if (!compact) return "";
  if (compact.length <= max) return compact;
  return `${compact.slice(0, max - 1)}…`;
}

function buildModelMessages(
  history: SessionHistoryEntry[],
  userText: string,
  imageBlocks: string[],
): ModelMessage[] {
  const messages: ModelMessage[] = [
    {
      role: "system",
      content:
        "You are dreclaw strict v0. Use tools only when needed. Return concise final answers. Do not echo user text. Use bash/read/write/edit only through tool calls. If a tool fails, briefly explain what failed, then recover or propose the next best action. Proactively use /memory for durable, decision-useful context: read it when useful, write/update .md files when important new context appears, keep it clean by merging duplicates/removing stale info, and never store secrets or credentials.",
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
