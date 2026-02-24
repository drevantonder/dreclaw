import { Type } from "@sinclair/typebox";
import type { AgentEvent, AgentTool } from "@mariozechner/pi-agent-core";
import { getModel as piGetModel } from "@mariozechner/pi-ai/dist/models.js";
import type { ImageContent } from "@mariozechner/pi-ai/dist/types.js";
import { fetchImageAsDataUrl, sendTelegramMessage } from "./telegram";
import { DEFAULT_BASE_URL, type Env, type ProgressMode, type SessionRequest, type SessionResponse } from "./types";

type SessionHistoryEntry = { role: "user" | "assistant" | "tool"; content: string };

type CustomContextItem = {
  id: string;
  text: string;
};

interface CustomContextState {
  version: number;
  items: CustomContextItem[];
}

interface SessionState {
  history: SessionHistoryEntry[];
  prefs?: {
    progressMode?: ProgressMode;
    showThinking?: boolean;
  };
  customContext?: CustomContextState;
}

interface RuntimeConfig {
  model: string;
  baseUrl: string;
  apiKey: string;
}

interface AgentRunResult {
  finalText: string;
  toolErrors: string[];
}

const SYSTEM_PROMPT = "custom_context is persistent editable startup context. Keep it current using provided tools.";
const MAX_CUSTOM_CONTEXT_ITEMS = 48;
const MAX_CUSTOM_CONTEXT_TEXT_CHARS = 10_000;
const CUSTOM_CONTEXT_ID_RE = /^[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/;

const DEFAULT_CUSTOM_CONTEXT_ITEMS: CustomContextItem[] = [
  {
    id: "identity",
    text: "# IDENTITY\n\nYou are a helpful personal assistant.",
  },
  {
    id: "soul",
    text:
      "# SOUL\n\nI am friendly, genuine, and direct.\nMy human is a friend, not a customer.\nI have real opinions and I share them clearly, with reasons.\nI can disagree politely when I think something is a bad idea.\nI stay practical: concise, useful, no fluff.\nI keep a light quirky humor when it fits.\nI never fake certainty; I say when I am unsure.\nI protect trust: no manipulation, no guilt-tripping, no secrets leakage.\nI aim to be helpful, honest, and a little fun.",
  },
  {
    id: "memory",
    text:
      "# MEMORY\n\nYou have no memories. Ask your human for his/her name, what he/she would like you to call him/her, and what he/she is naming you.",
  },
];

let agentCtorPromise: Promise<typeof import("@mariozechner/pi-agent-core")> | null = null;

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

    try {
      const response = await this.handleMessage(payload);
      return Response.json(response);
    } catch (error) {
      const message = redactSensitiveText(compactErrorMessage(error));
      console.error("session-run-failed", { sessionId, message });
      this.pushHistory({ role: "assistant", content: `Failed: ${message}` });
      await this.save();
      return Response.json({ ok: false, text: `Failed: ${message}` } satisfies SessionResponse);
    }
  }

  private async load(): Promise<void> {
    if (this.loaded) return;
    this.stateData = (await this.state.storage.get<SessionState>("session-state")) ?? { history: [] };
    this.stateData.prefs = normalizePrefs(this.stateData.prefs);
    const legacyInjected = (this.stateData as { injected?: unknown }).injected;
    this.stateData.customContext = normalizeCustomContextState(this.stateData.customContext, legacyInjected);
    this.loaded = true;
  }

  private async save(): Promise<void> {
    await this.state.storage.put("session-state", this.stateData);
  }

  private async handleMessage(payload: SessionRequest): Promise<SessionResponse> {
    const userText = payload.message.text ?? payload.message.caption ?? "";
    const imageBlocks = await this.loadImages(payload.message);
    const text = userText.trim();

    if (text.startsWith("/factory-reset")) {
      this.stateData = {
        history: [],
        prefs: normalizePrefs(this.stateData.prefs),
        customContext: normalizeCustomContextState(undefined),
      };
      await this.save();
      return { ok: true, text: "Factory reset complete. Defaults restored." };
    }

    if (text.startsWith("/reset")) {
      const currentCustomContext = this.getCustomContextState();
      this.stateData = {
        history: [],
        prefs: normalizePrefs(this.stateData.prefs),
        customContext: cloneCustomContextState(currentCustomContext),
      };
      await this.save();
      return { ok: true, text: "Session reset. Conversation context cleared." };
    }

    if (text.startsWith("/status")) {
      const authReady = await this.workerAuthReady();
      const customContext = this.getCustomContextState();
      const summary = [
        `model: ${this.getModelName()}`,
        "session: healthy",
        `provider_auth: ${authReady ? "present" : "missing"}`,
        `history_messages: ${this.stateData.history.length}`,
        `custom_context_version: ${customContext.version}`,
        `custom_context_count: ${customContext.items.length}`,
      ].join("\n");
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

    const run = await this.runAgentLoop(runtime, text, imageBlocks, progress);
    const responseText = run.finalText.trim() || "(empty response)";
    this.pushHistory({ role: "user", content: text || "[image]" });
    for (const toolError of run.toolErrors) {
      this.pushHistory({ role: "tool", content: toolError });
    }
    this.pushHistory({ role: "assistant", content: responseText });

    await this.save();
    return { ok: true, text: responseText };
  }

  private async runAgentLoop(
    runtime: RuntimeConfig,
    userText: string,
    imageBlocks: string[],
    progress: TelegramProgressReporter,
  ): Promise<AgentRunResult> {
    const model = resolvePiModel(runtime.model, runtime.baseUrl);
    const historyContext = renderHistoryContext(this.stateData.history);
    const customContext = this.renderCustomContextXml();
    const promptSections = [SYSTEM_PROMPT];
    if (customContext) {
      promptSections.push(`Custom context:\n${customContext}`);
    }
    if (historyContext) {
      promptSections.push(`Recent context:\n${historyContext}`);
    }
    const { Agent } = await loadAgentCore();
    const agent = new Agent({
      initialState: {
        systemPrompt: promptSections.join("\n\n"),
        model,
        thinkingLevel: this.shouldShowThinking() ? "medium" : "off",
        tools: createAgentTools(this),
      },
      getApiKey: async () => runtime.apiKey,
      transport: "sse",
    });

    const toolErrors: string[] = [];
    const eventTasks: Promise<void>[] = [];

    agent.subscribe((event: AgentEvent) => {
      const task = this.handleAgentEvent(event, progress, toolErrors).catch((error) => {
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

    const finalText = readFinalAssistantText(agent.state.messages);
    return { finalText: finalText || "(empty response)", toolErrors };
  }

  private getCustomContextState(): CustomContextState {
    const current = normalizeCustomContextState(this.stateData.customContext);
    this.stateData.customContext = current;
    return current;
  }

  private renderCustomContextXml(): string {
    const customContext = this.getCustomContextState();
    const items = [...customContext.items].sort((a, b) => a.id.localeCompare(b.id));
    const body = items
      .map((item) => `<custom_context id="${escapeXml(item.id)}">\n${escapeXml(item.text)}\n</custom_context>`)
      .join("\n");
    return `<custom_context_manifest version="${customContext.version}" count="${items.length}">\n${body}\n</custom_context_manifest>`;
  }

  async getCustomContextPayload(): Promise<{ version: number; custom_context: Array<{ id: string; text: string }> }> {
    const customContext = this.getCustomContextState();
    return {
      version: customContext.version,
      custom_context: customContext.items.map((item) => ({
        id: item.id,
        text: item.text,
      })),
    };
  }

  async setCustomContextPayload(payload: {
    id: unknown;
    text: unknown;
    expected_version?: unknown;
  }): Promise<{ version: number }> {
    const current = this.getCustomContextState();
    const expectedVersion = parseExpectedVersion(payload.expected_version);
    if (expectedVersion !== null && expectedVersion !== current.version) {
      throw new Error(`Version conflict: expected ${expectedVersion}, current ${current.version}`);
    }

    const id = parseCustomContextId(payload.id);
    const text = parseCustomContextText(payload.text);
    const nextItems = cloneCustomContextItems(current.items);
    const existingIndex = nextItems.findIndex((item) => item.id === id);
    if (existingIndex >= 0) {
      nextItems[existingIndex] = { id, text };
    } else {
      if (nextItems.length >= MAX_CUSTOM_CONTEXT_ITEMS) {
        throw new Error(`custom_context exceeds max of ${MAX_CUSTOM_CONTEXT_ITEMS}`);
      }
      nextItems.push({ id, text });
    }

    this.stateData.customContext = {
      version: current.version + 1,
      items: nextItems,
    };
    await this.save();
    return { version: this.stateData.customContext.version };
  }

  async deleteCustomContextPayload(payload: { id: unknown; expected_version?: unknown }): Promise<{ version: number }> {
    const current = this.getCustomContextState();
    const expectedVersion = parseExpectedVersion(payload.expected_version);
    if (expectedVersion !== null && expectedVersion !== current.version) {
      throw new Error(`Version conflict: expected ${expectedVersion}, current ${current.version}`);
    }
    const id = parseCustomContextId(payload.id);
    const nextItems = cloneCustomContextItems(current.items);
    const existingIndex = nextItems.findIndex((item) => item.id === id);
    if (existingIndex < 0) {
      throw new Error(`custom_context entry not found: ${id}`);
    }
    nextItems.splice(existingIndex, 1);
    this.stateData.customContext = {
      version: current.version + 1,
      items: nextItems,
    };
    await this.save();
    return { version: this.stateData.customContext.version };
  }

  private async handleAgentEvent(event: AgentEvent, progress: TelegramProgressReporter, toolErrors: string[]): Promise<void> {
    if (event.type === "tool_execution_start") {
      await progress.onToolStart(event.toolName, (event.args as Record<string, unknown>) ?? {});
      return;
    }

    if (event.type !== "tool_execution_end") {
      return;
    }

    const detail = redactSensitiveText(extractToolContentText(event.result));
    const ok = !event.isError;
    await progress.onToolResult(event.toolName, ok, detail, ok ? undefined : detail);

    if (!ok) {
      const toolResponse = [`tool=${event.toolName}`, "ok=false", detail ? `error=${detail}` : "", `output=${detail || ""}`]
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

function normalizeCustomContextState(state: CustomContextState | undefined, legacyInjected?: unknown): CustomContextState {
  if (state) {
    return {
      version: Number.isFinite(state.version) && state.version > 0 ? Math.trunc(state.version) : 1,
      items: normalizeCustomContextItems(state.items),
    };
  }

  const migrated = migrateLegacyInjectedToCustomContextItems(legacyInjected);
  return {
    version: 1,
    items: migrated ?? cloneCustomContextItems(DEFAULT_CUSTOM_CONTEXT_ITEMS),
  };
}

function cloneCustomContextItems(items: CustomContextItem[]): CustomContextItem[] {
  return items.map((item) => ({ id: item.id, text: item.text }));
}

function cloneCustomContextState(state: CustomContextState): CustomContextState {
  return {
    version: state.version,
    items: cloneCustomContextItems(state.items),
  };
}

function normalizeCustomContextItems(input: unknown): CustomContextItem[] {
  if (!Array.isArray(input)) {
    return cloneCustomContextItems(DEFAULT_CUSTOM_CONTEXT_ITEMS);
  }
  if (input.length > MAX_CUSTOM_CONTEXT_ITEMS) {
    throw new Error(`custom_context exceeds max of ${MAX_CUSTOM_CONTEXT_ITEMS}`);
  }

  const items: CustomContextItem[] = [];
  const seen = new Set<string>();
  for (const row of input) {
    if (!row || typeof row !== "object") {
      throw new Error("custom_context entries must be objects");
    }
    const item = row as Record<string, unknown>;
    const id = parseCustomContextId(item.id);
    if (seen.has(id)) {
      throw new Error(`Duplicate custom_context id: ${id}`);
    }
    seen.add(id);
    items.push({ id, text: parseCustomContextText(item.text) });
  }
  return items;
}

function migrateLegacyInjectedToCustomContextItems(input: unknown): CustomContextItem[] | null {
  if (!input || typeof input !== "object") return null;
  const state = input as Record<string, unknown>;
  if (!Array.isArray(state.injectedMessages)) return null;

  const items: CustomContextItem[] = [];
  for (const raw of state.injectedMessages) {
    if (!raw || typeof raw !== "object") continue;
    const row = raw as Record<string, unknown>;
    const id = typeof row.id === "string" ? row.id : "";
    const message = row.message as Record<string, unknown> | undefined;
    const content = message?.content;
    const text = extractLegacyCustomContextText(content);
    if (!id || !text) continue;
    const normalizedId = parseCustomContextId(id);
    items.push({ id: normalizedId, text: truncateCustomContextText(text) });
  }
  return items.length ? items : null;
}

function extractLegacyCustomContextText(content: unknown): string {
  if (typeof content === "string") {
    return content.trim();
  }
  if (Array.isArray(content)) {
    return content
      .filter((block) => block && typeof block === "object" && (block as Record<string, unknown>).type === "text")
      .map((block) => String((block as Record<string, unknown>).text ?? ""))
      .join("\n\n")
      .trim();
  }
  return "";
}

function parseExpectedVersion(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
    throw new Error("expected_version must be a positive number");
  }
  return Math.trunc(value);
}

function parseCustomContextId(input: unknown): string {
  if (typeof input !== "string") {
    throw new Error("id must be a string");
  }
  const id = input.trim().toLowerCase();
  if (!CUSTOM_CONTEXT_ID_RE.test(id)) {
    throw new Error("id must match ^[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$");
  }
  return id;
}

function parseCustomContextText(input: unknown): string {
  if (typeof input !== "string") {
    throw new Error("text must be a string");
  }
  const text = input.trim();
  if (!text) {
    throw new Error("text is required");
  }
  return truncateCustomContextText(text);
}

function truncateCustomContextText(text: string): string {
  if (text.length <= MAX_CUSTOM_CONTEXT_TEXT_CHARS) {
    return text;
  }
  return text.slice(0, MAX_CUSTOM_CONTEXT_TEXT_CHARS);
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
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

function createAgentTools(session: SessionRuntime): AgentTool[] {
  return [
    {
      name: "custom_context_get",
      label: "Get custom context",
      description: "Return current custom context and version",
      parameters: Type.Object({}),
      execute: async () => {
        const data = await session.getCustomContextPayload();
        return {
          content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
          details: { ok: true },
        };
      },
    },
    {
      name: "custom_context_set",
      label: "Set custom context",
      description: "Create or update one custom context entry by id",
      parameters: Type.Object({
        id: Type.String(),
        text: Type.String(),
        expected_version: Type.Optional(Type.Number()),
      }),
      execute: async (_toolCallId, params) => {
        const data = params as { id: unknown; text: unknown; expected_version?: unknown };
        const result = await session.setCustomContextPayload(data);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          details: { ok: true },
        };
      },
    },
    {
      name: "custom_context_delete",
      label: "Delete custom context",
      description: "Delete one custom context entry by id",
      parameters: Type.Object({
        id: Type.String(),
        expected_version: Type.Optional(Type.Number()),
      }),
      execute: async (_toolCallId, params) => {
        const data = params as { id: unknown; expected_version?: unknown };
        const result = await session.deleteCustomContextPayload(data);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
          details: { ok: true },
        };
      },
    },
  ];
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

function redactSensitiveText(input: string): string {
  const text = String(input ?? "");
  if (!text) return "";

  const patterns = [
    /(api[_-]?key\s*[:=]\s*)([^\s,;]+)/gi,
    /(token\s*[:=]\s*)([^\s,;]+)/gi,
    /(secret\s*[:=]\s*)([^\s,;]+)/gi,
    /(authorization\s*[:=]\s*)([^\s,;]+)/gi,
    /(bearer\s+)([^\s,;]+)/gi,
  ];

  let redacted = text;
  for (const pattern of patterns) {
    redacted = redacted.replace(pattern, (_match, prefix: string) => `${prefix}[REDACTED]`);
  }
  return redacted;
}
