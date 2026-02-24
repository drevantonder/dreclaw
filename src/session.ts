import { DEFAULT_BASE_URL, VFS_ROOT, type Env, type ProgressMode, type SessionRequest, type SessionResponse } from "./types";
import { Type } from "@sinclair/typebox";
import type { AgentEvent, AgentTool } from "@mariozechner/pi-agent-core";
import { getModel as piGetModel } from "@mariozechner/pi-ai/dist/models.js";
import type { ImageContent } from "@mariozechner/pi-ai/dist/types.js";
import { finishRun, startRun, upsertSessionMeta } from "./db";
import { R2FilesystemService } from "./filesystem";
import { runTool, SessionShell } from "./tools";
import { fetchImageAsDataUrl, sendTelegramMessage } from "./telegram";

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

const SYSTEM_PROMPT =
  "You are dreclaw strict v0. Use tools only when needed. Return concise final answers. Do not echo user text. Use bash/read/write/edit only through tool calls. If a tool fails, briefly explain what failed, then recover or propose the next best action. Proactively use /memory for durable, decision-useful context: read it when useful, write/update .md files when important new context appears, keep it clean by merging duplicates/removing stale info, and never store secrets or credentials.";

let agentCtorPromise: Promise<typeof import("@mariozechner/pi-agent-core")> | null = null;

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
      showThinking: this.shouldShowThinking(),
    });

    const run = await this.runAgentLoop(shell, runtime, text, imageBlocks, progress, sessionId);
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
    sessionId: string,
  ): Promise<AgentRunResult> {
    const model = resolvePiModel(runtime.model, runtime.baseUrl);
    const historyContext = renderHistoryContext(this.stateData.history);
    const tools = createAgentTools(shell);
    const { Agent } = await loadAgentCore();
    const agent = new Agent({
      initialState: {
        systemPrompt: historyContext ? `${SYSTEM_PROMPT}\n\nRecent context:\n${historyContext}` : SYSTEM_PROMPT,
        model,
        thinkingLevel: this.shouldShowThinking() ? "medium" : "off",
        tools,
      },
      getApiKey: async () => runtime.apiKey,
      transport: "sse",
    });
    const toolErrors: string[] = [];
    const toolEvents: ToolEvent[] = [];
    const eventTasks: Promise<void>[] = [];
    const fsMetricsStart = shell.metricsSnapshot();

    agent.subscribe((event: AgentEvent) => {
      const task = this.handleAgentEvent(event, progress, toolEvents, toolErrors).catch((error) => {
        console.warn("agent-event-handler-failed", {
          error: error instanceof Error ? error.message : String(error ?? "unknown"),
        });
      });
      eventTasks.push(task);
    });

    const images = imageBlocks.map(toPiImageContent).filter((item): item is ImageContent => Boolean(item));
    await agent.prompt(userText || "[image message]", images);
    if (eventTasks.length) {
      await Promise.all(eventTasks);
    }
    if (this.shouldShowThinking()) {
      await progress.sendThinkingSummary(readFinalAssistantThinking(agent.state.messages));
    }
    const fsMetrics = shell.metricsDelta(fsMetricsStart);
    console.info("session-fs-metrics", {
      sessionId,
      flush_calls: fsMetrics.flushCalls,
      flush_ms_total: fsMetrics.flushMsTotal,
      flush_ms_max: fsMetrics.flushMsMax,
      ensure_loaded_calls: fsMetrics.ensureLoadedCalls,
      ensure_loaded_cold_starts: fsMetrics.ensureLoadedColdStarts,
      scan_calls: fsMetrics.captureChangesCalls,
      scanned_paths: fsMetrics.scannedPaths,
      changed_marks: fsMetrics.changedPathMarks,
      deleted_marks: fsMetrics.deletedPathMarks,
      r2_list_calls: fsMetrics.r2ListCalls,
      r2_get_calls: fsMetrics.r2GetCalls,
      r2_get_bytes: fsMetrics.r2GetBytes,
      r2_put_calls: fsMetrics.r2PutCalls,
      r2_put_bytes: fsMetrics.r2PutBytes,
      r2_delete_batches: fsMetrics.r2DeleteBatches,
      r2_delete_keys: fsMetrics.r2DeleteKeys,
    });

    const finalText = readFinalAssistantText(agent.state.messages);
    return { finalText: finalText || "(empty response)", toolErrors, toolEvents };
  }

  private async handleAgentEvent(
    event: AgentEvent,
    progress: TelegramProgressReporter,
    toolEvents: ToolEvent[],
    toolErrors: string[],
  ): Promise<void> {
    if (event.type === "tool_execution_start") {
      await progress.onToolStart(event.toolName, (event.args as Record<string, unknown>) ?? {});
      return;
    }

    if (event.type !== "tool_execution_end") {
      return;
    }

    const detail = extractToolContentText(event.result);
    const ok = !event.isError;
    toolEvents.push(buildToolEvent(event.toolName, ok, detail, ok ? undefined : detail));
    await progress.onToolResult(event.toolName, ok, detail, ok ? undefined : detail);

    if (!ok) {
      const toolResponse = [
        `tool=${event.toolName}`,
        "ok=false",
        detail ? `error=${detail}` : "",
        `output=${detail || ""}`,
      ]
        .filter(Boolean)
        .join("\n");
      toolErrors.push(toolResponse);
      console.error("tool-call-failed", { tool: event.toolName, error: detail || "tool failed" });
    }
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

function resolvePiModel(model: string, baseUrl: string) {
  try {
    return {
      ...piGetModel("opencode", model as "kimi-k2.5"),
      baseUrl,
    };
  } catch {
    return {
      ...piGetModel("opencode", "kimi-k2.5"),
      id: model,
      name: model,
      baseUrl,
    };
  }
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

function renderHistoryContext(history: SessionHistoryEntry[]): string {
  const recent = history.slice(-10);
  if (!recent.length) {
    return "";
  }
  return recent
    .map((entry) => `${entry.role}: ${truncateForLog(entry.content, 700)}`)
    .join("\n");
}

function toPiImageContent(dataUrl: string): ImageContent | null {
  const parsed = parseDataUrl(dataUrl);
  if (!parsed) {
    return null;
  }
  return {
    type: "image",
    data: parsed.data,
    mimeType: parsed.mimeType,
  };
}

function parseDataUrl(url: string): { mimeType: string; data: string } | null {
  const match = /^data:([^;]+);base64,(.+)$/i.exec(url.trim());
  if (!match) {
    return null;
  }
  return { mimeType: match[1], data: match[2] };
}

function createAgentTools(shell: SessionShell): AgentTool[] {
  return [
    {
      name: "read",
      label: "Read file",
      description: "Read file content from session filesystem",
      parameters: Type.Object({ path: Type.String() }),
      execute: async (_toolCallId, params) => {
        const data = params as { path: string };
        return executeSessionTool(shell, "read", { path: data.path });
      },
    },
    {
      name: "write",
      label: "Write file",
      description: "Write file content to session filesystem",
      parameters: Type.Object({ path: Type.String(), content: Type.String() }),
      execute: async (_toolCallId, params) => {
        const data = params as { path: string; content: string };
        return executeSessionTool(shell, "write", { path: data.path, content: data.content });
      },
    },
    {
      name: "edit",
      label: "Edit file",
      description: "Replace text in a file",
      parameters: Type.Object({ path: Type.String(), find: Type.String(), replace: Type.String() }),
      execute: async (_toolCallId, params) => {
        const data = params as { path: string; find: string; replace: string };
        return executeSessionTool(shell, "edit", { path: data.path, find: data.find, replace: data.replace });
      },
    },
    {
      name: "bash",
      label: "Run command",
      description: "Run shell command in session filesystem",
      parameters: Type.Object({ command: Type.String() }),
      execute: async (_toolCallId, params) => {
        const data = params as { command: string };
        return executeSessionTool(shell, "bash", { command: data.command }, { timeoutMs: 15_000 });
      },
    },
  ];
}

async function executeSessionTool(
  shell: SessionShell,
  name: "read" | "write" | "edit" | "bash",
  args: Record<string, unknown>,
  options?: { timeoutMs?: number },
): Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> }> {
  const runner = runTool({ name, args }, { shell });
  const result = options?.timeoutMs ? await withTimeout(runner, options.timeoutMs) : await runner;
  const text = truncateForLog(result.output || result.error || "(no output)", 2000) || "(no output)";

  if (!result.ok) {
    throw new Error(result.error || text || "Tool failed");
  }

  return {
    content: [{ type: "text", text }],
    details: { ok: true },
  };
}

async function loadAgentCore(): Promise<typeof import("@mariozechner/pi-agent-core")> {
  if (!agentCtorPromise) {
    enableWorkerCspShim();
    agentCtorPromise = import("@mariozechner/pi-agent-core");
  }
  return agentCtorPromise;
}

function enableWorkerCspShim(): void {
  const value = globalThis as Record<string, unknown>;
  const chromeValue = (value.chrome as Record<string, unknown> | undefined) ?? {};
  const runtimeValue = (chromeValue.runtime as Record<string, unknown> | undefined) ?? {};
  if (!runtimeValue.id) runtimeValue.id = "workers";
  chromeValue.runtime = runtimeValue;
  value.chrome = chromeValue;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`Tool timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

function extractToolContentText(result: unknown): string {
  const content = (result as { content?: Array<{ type?: string; text?: string }> } | null)?.content;
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text ?? "")
    .join("\n")
    .trim();
}

function readFinalAssistantText(messages: unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as { role?: string; content?: Array<{ type?: string; text?: string }> };
    if (message?.role !== "assistant" || !Array.isArray(message.content)) {
      continue;
    }
    const text = message.content
      .filter((block) => block?.type === "text" && typeof block.text === "string")
      .map((block) => block.text ?? "")
      .join("\n")
      .trim();
    if (text) {
      return text;
    }
  }
  return "";
}

function readFinalAssistantThinking(messages: unknown[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as { role?: string; content?: Array<{ type?: string; thinking?: string }> };
    if (message?.role !== "assistant" || !Array.isArray(message.content)) {
      continue;
    }
    const thinking = message.content
      .filter((block) => block?.type === "thinking" && typeof block.thinking === "string")
      .map((block) => block.thinking ?? "")
      .join("\n")
      .trim();
    if (thinking) {
      return thinking;
    }
  }
  return "";
}

class TelegramProgressReporter {
  private readonly token: string;
  private readonly chatId: number;
  private readonly mode: ProgressMode;
  private readonly showThinking: boolean;
  private toolStartAtByName = new Map<string, number>();

  constructor(params: {
    token: string;
    chatId: number;
    mode: ProgressMode;
    showThinking: boolean;
  }) {
    this.token = params.token;
    this.chatId = params.chatId;
    this.mode = params.mode;
    this.showThinking = params.showThinking;
  }

  async sendThinkingSummary(raw: string): Promise<void> {
    if (!this.showThinking) return;
    const text = truncateForLog(raw, 700);
    if (!text) return;
    await this.safeSendMessage(`Thinking:\n${text}`);
  }

  async onToolStart(name: string, args: Record<string, unknown>): Promise<void> {
    this.toolStartAtByName.set(name, Date.now());

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
      const detail = truncateForLog(error || output || "error", 700);
      if (this.mode !== "compact") {
        await this.safeSendMessage(`Tool error: ${name}${detail ? ` ${detail}` : ""}`);
      }
      return;
    }

    if (this.mode === "verbose") {
      await this.safeSendMessage(`Tool ok: ${name}${elapsedMs >= 3000 ? ` (${Math.round(elapsedMs / 100) / 10}s)` : ""}`);
      return;
    }
    if (this.mode === "debug") {
      const detail = truncateForLog(output, 700);
      await this.safeSendMessage(`Tool ok: ${name}${detail ? ` ${detail}` : ""}`);
      return;
    }
  }

  private async safeSendMessage(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;
    try {
      await sendTelegramMessage(this.token, this.chatId, trimmed);
    } catch (error) {
      console.warn("telegram-progress-send-failed", {
        chatId: this.chatId,
        error: error instanceof Error ? error.message : String(error ?? "unknown"),
      });
    }
  }
}

function truncateForLog(input: string, max: number): string {
  const compact = String(input ?? "").replace(/\s+/g, " ").trim();
  if (!compact) return "";
  if (compact.length <= max) return compact;
  return `${compact.slice(0, max - 1)}…`;
}
