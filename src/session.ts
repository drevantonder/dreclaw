import { Type } from "@sinclair/typebox";
import type { AgentEvent, AgentTool } from "@mariozechner/pi-agent-core";
import { getModel as piGetModel } from "@mariozechner/pi-ai/dist/models.js";
import type { ImageContent } from "@mariozechner/pi-ai/dist/types.js";
import { finishRun, startRun, upsertSessionMeta } from "./db";
import { fetchImageAsDataUrl, sendTelegramMessage } from "./telegram";
import { DEFAULT_BASE_URL, type Env, type ProgressMode, type SessionRequest, type SessionResponse } from "./types";

type SessionHistoryEntry = { role: "user" | "assistant" | "tool"; content: string };

type InjectedRole = "system" | "user" | "assistant" | "toolResult";

type InjectedMessage = {
  role: InjectedRole;
  content: unknown;
};

type InjectedMessageItem = {
  id: string;
  message: InjectedMessage;
};

interface InjectedMessagesState {
  version: number;
  injectedMessages: InjectedMessageItem[];
}

interface SessionState {
  history: SessionHistoryEntry[];
  prefs?: {
    progressMode?: ProgressMode;
    showThinking?: boolean;
  };
  injected?: InjectedMessagesState;
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

const DEFAULT_CUSTOM_CONTEXT_ITEMS: InjectedMessageItem[] = [
  {
    id: "identity",
    message: {
      role: "system",
      content: [
        {
          type: "text",
          text: "# IDENTITY\n\nYou are a helpful personal assistant.",
        },
      ],
    },
  },
  {
    id: "soul",
    message: {
      role: "system",
      content: [
        {
          type: "text",
          text:
            "# SOUL\n\nI am friendly, genuine, and direct.\nMy human is a friend, not a customer.\nI have real opinions and I share them clearly, with reasons.\nI can disagree politely when I think something is a bad idea.\nI stay practical: concise, useful, no fluff.\nI keep a light quirky humor when it fits.\nI never fake certainty; I say when I am unsure.\nI protect trust: no manipulation, no guilt-tripping, no secrets leakage.\nI aim to be helpful, honest, and a little fun.",
        },
      ],
    },
  },
  {
    id: "memory",
    message: {
      role: "system",
      content: [
        {
          type: "text",
          text:
            "# MEMORY\n\nYou have no memories. Ask your human for his/her name, what he/she would like you to call him/her, and what he/she is naming you.",
        },
      ],
    },
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
    const runId = crypto.randomUUID();
    await startRun(this.env.DRECLAW_DB, runId, sessionId);

    try {
      const response = await this.handleMessage(payload, sessionId);
      await finishRun(this.env.DRECLAW_DB, runId);
      return Response.json(response);
    } catch (error) {
      const message = redactSensitiveText(compactErrorMessage(error));
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
    this.stateData.injected = normalizeInjectedState(this.stateData.injected);
    this.loaded = true;
  }

  private async save(): Promise<void> {
    await this.state.storage.put("session-state", this.stateData);
  }

  private async handleMessage(payload: SessionRequest, sessionId: string): Promise<SessionResponse> {
    const userText = payload.message.text ?? payload.message.caption ?? "";
    const imageBlocks = await this.loadImages(payload.message);
    const text = userText.trim();

    if (text.startsWith("/factory-reset")) {
      this.stateData = {
        history: [],
        prefs: normalizePrefs(this.stateData.prefs),
        injected: normalizeInjectedState(undefined),
      };
      await this.save();
      await upsertSessionMeta(this.env.DRECLAW_DB, sessionId, payload.message.chat.id, this.getModelName(), await this.workerAuthReady());
      return { ok: true, text: "Factory reset complete. Defaults restored." };
    }

    if (text.startsWith("/reset")) {
      const currentInjected = this.getInjectedState();
      this.stateData = {
        history: [],
        prefs: normalizePrefs(this.stateData.prefs),
        injected: cloneInjectedState(currentInjected),
      };
      await this.save();
      await upsertSessionMeta(this.env.DRECLAW_DB, sessionId, payload.message.chat.id, this.getModelName(), await this.workerAuthReady());
      return { ok: true, text: "Session reset. Conversation context cleared." };
    }

    if (text.startsWith("/status")) {
      const authReady = await this.workerAuthReady();
      const injected = this.getInjectedState();
      const summary = [
        `model: ${this.getModelName()}`,
        "session: healthy",
        `provider_auth: ${authReady ? "present" : "missing"}`,
        `history_messages: ${this.stateData.history.length}`,
        `custom_context_version: ${injected.version}`,
        `custom_context_count: ${injected.injectedMessages.length}`,
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

    const run = await this.runAgentLoop(runtime, text, imageBlocks, progress);
    const responseText = run.finalText.trim() || "(empty response)";
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

  private getInjectedState(): InjectedMessagesState {
    const current = normalizeInjectedState(this.stateData.injected);
    this.stateData.injected = current;
    return current;
  }

  private renderCustomContextXml(): string {
    const injected = this.getInjectedState();
    const items = [...injected.injectedMessages].sort((a, b) => a.id.localeCompare(b.id));
    const body = items
      .map((item) => {
        const content = customContextContentToText(item.message.content);
        return `<custom_context id="${escapeXml(item.id)}">\n${escapeXml(content)}\n</custom_context>`;
      })
      .join("\n");
    return `<custom_context_manifest version="${injected.version}" count="${items.length}">\n${body}\n</custom_context_manifest>`;
  }

  async getInjectedMessagesPayload(): Promise<{ version: number; custom_context: Array<{ id: string; role: InjectedRole; content: unknown }> }> {
    const injected = this.getInjectedState();
    return {
      version: injected.version,
      custom_context: injected.injectedMessages.map((item) => ({
        id: item.id,
        role: item.message.role,
        content: deepClone(item.message.content),
      })),
    };
  }

  async setInjectedMessagePayload(payload: {
    id: unknown;
    message: unknown;
    expected_version?: unknown;
  }): Promise<{ version: number }> {
    const current = this.getInjectedState();
    const expectedVersion = parseExpectedVersion(payload.expected_version);
    if (expectedVersion !== null && expectedVersion !== current.version) {
      throw new Error(`Version conflict: expected ${expectedVersion}, current ${current.version}`);
    }

    const id = parseCustomContextId(payload.id);
    const message = normalizeIncomingCustomContextMessage(payload.message);
    const nextMessages = cloneInjectedMessages(current.injectedMessages);
    const existingIndex = nextMessages.findIndex((item) => item.id === id);
    if (existingIndex >= 0) {
      nextMessages[existingIndex] = { id, message };
    } else {
      if (nextMessages.length >= MAX_CUSTOM_CONTEXT_ITEMS) {
        throw new Error(`custom_context exceeds max of ${MAX_CUSTOM_CONTEXT_ITEMS}`);
      }
      nextMessages.push({ id, message });
    }

    this.stateData.injected = {
      version: current.version + 1,
      injectedMessages: nextMessages,
    };
    await this.save();
    return { version: this.stateData.injected.version };
  }

  async deleteInjectedMessagePayload(payload: { id: unknown; expected_version?: unknown }): Promise<{ version: number }> {
    const current = this.getInjectedState();
    const expectedVersion = parseExpectedVersion(payload.expected_version);
    if (expectedVersion !== null && expectedVersion !== current.version) {
      throw new Error(`Version conflict: expected ${expectedVersion}, current ${current.version}`);
    }
    const id = parseCustomContextId(payload.id);
    const nextMessages = cloneInjectedMessages(current.injectedMessages);
    const existingIndex = nextMessages.findIndex((item) => item.id === id);
    if (existingIndex < 0) {
      throw new Error(`custom_context entry not found: ${id}`);
    }
    nextMessages.splice(existingIndex, 1);
    this.stateData.injected = {
      version: current.version + 1,
      injectedMessages: nextMessages,
    };
    await this.save();
    return { version: this.stateData.injected.version };
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

function normalizeInjectedState(state: InjectedMessagesState | undefined): InjectedMessagesState {
  if (!state) {
    return { version: 1, injectedMessages: cloneInjectedMessages(DEFAULT_CUSTOM_CONTEXT_ITEMS) };
  }
  const version = Number.isFinite(state.version) && state.version > 0 ? Math.trunc(state.version) : 1;
  const injectedMessages = normalizeInjectedItems(state.injectedMessages);
  return { version, injectedMessages };
}

function cloneInjectedMessages(messages: InjectedMessageItem[]): InjectedMessageItem[] {
  return messages.map((message) => ({
    id: message.id,
    message: {
      role: message.message.role,
      content: deepClone(message.message.content),
    },
  }));
}

function cloneInjectedState(state: InjectedMessagesState): InjectedMessagesState {
  return {
    version: state.version,
    injectedMessages: cloneInjectedMessages(state.injectedMessages),
  };
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function parseExpectedVersion(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 1) {
    throw new Error("expected_version must be a positive number");
  }
  return Math.trunc(value);
}

function normalizeInjectedItems(input: unknown): InjectedMessageItem[] {
  if (!Array.isArray(input)) {
    return cloneInjectedMessages(DEFAULT_CUSTOM_CONTEXT_ITEMS);
  }
  if (input.length > MAX_CUSTOM_CONTEXT_ITEMS) {
    throw new Error(`custom_context exceeds max of ${MAX_CUSTOM_CONTEXT_ITEMS}`);
  }
  if (!input.length) return [];

  const first = input[0];
  const isNewShape = Boolean(first && typeof first === "object" && "id" in (first as Record<string, unknown>) && "message" in (first as Record<string, unknown>));
  return isNewShape ? validateInjectedItems(input) : migrateLegacyInjectedMessages(input);
}

function validateInjectedItems(input: unknown[]): InjectedMessageItem[] {
  const result: InjectedMessageItem[] = [];
  const seenIds = new Set<string>();
  for (const item of input) {
    if (!item || typeof item !== "object") {
      throw new Error("Each custom_context entry must be an object");
    }
    const row = item as Record<string, unknown>;
    const id = parseCustomContextId(row.id);
    if (seenIds.has(id)) {
      throw new Error(`Duplicate custom_context id: ${id}`);
    }
    seenIds.add(id);
    const message = validateInjectedMessage(row.message);
    result.push({ id, message });
  }
  return result;
}

function migrateLegacyInjectedMessages(input: unknown[]): InjectedMessageItem[] {
  const result: InjectedMessageItem[] = [];
  for (let index = 0; index < input.length; index += 1) {
    const message = validateInjectedMessage(input[index]);
    result.push({ id: `message-${index + 1}`, message });
  }
  return result;
}

function validateInjectedMessage(input: unknown): InjectedMessage {
  if (!input || typeof input !== "object") {
    throw new Error("custom_context entry must be an object");
  }
  const row = input as Record<string, unknown>;
  const role = row.role;
  if (role !== "system" && role !== "user" && role !== "assistant" && role !== "toolResult") {
    throw new Error("custom_context role must be system, user, assistant, or toolResult");
  }
  ensureValidMessageContent(row.content, role);
  return { role, content: deepClone(row.content) };
}

function normalizeIncomingCustomContextMessage(input: unknown): InjectedMessage {
  if (typeof input === "string") {
    ensureValidMessageContent(input, "system");
    return { role: "system", content: input };
  }
  return validateInjectedMessage(input);
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

function ensureValidMessageContent(content: unknown, role: InjectedRole): void {
  if (typeof content === "string") {
    if (content.length > MAX_CUSTOM_CONTEXT_TEXT_CHARS) {
      throw new Error("custom_context content exceeds max length");
    }
    return;
  }

  if (!Array.isArray(content)) {
    throw new Error("custom_context content must be string or array");
  }

  for (const block of content) {
    if (!block || typeof block !== "object") {
      throw new Error("custom_context block must be an object");
    }
    const value = block as Record<string, unknown>;
    const type = value.type;
    if (type === "text") {
      if (typeof value.text !== "string") {
        throw new Error("text block requires string text");
      }
      if (value.text.length > MAX_CUSTOM_CONTEXT_TEXT_CHARS) {
        throw new Error("custom_context text block exceeds max length");
      }
      continue;
    }
    if (type === "toolCall") {
      if (typeof value.id !== "string" || !value.id.trim()) throw new Error("toolCall block requires id");
      if (typeof value.name !== "string" || !value.name.trim()) throw new Error("toolCall block requires name");
      if (typeof value.arguments !== "object" || !value.arguments) throw new Error("toolCall block requires arguments object");
      continue;
    }
    if (type === "toolResult") {
      if (typeof value.toolCallId !== "string" || !value.toolCallId.trim()) throw new Error("toolResult block requires toolCallId");
      if (typeof value.toolName !== "string" || !value.toolName.trim()) throw new Error("toolResult block requires toolName");
      if (!Array.isArray(value.content)) throw new Error("toolResult block requires content array");
      continue;
    }
    throw new Error(`Unsupported custom_context block type: ${String(type)}`);
  }

  if (role === "toolResult") {
    return;
  }
}

function customContextContentToText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    const textBlocks = content
      .filter((block) => typeof block === "object" && block !== null && (block as Record<string, unknown>).type === "text")
      .map((block) => String((block as Record<string, unknown>).text ?? ""))
      .filter(Boolean);
    if (textBlocks.length > 0) {
      return textBlocks.join("\n\n");
    }
  }
  return JSON.stringify(content, null, 2);
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
        const data = await session.getInjectedMessagesPayload();
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
        message: Type.Any(),
        expected_version: Type.Optional(Type.Number()),
      }),
      execute: async (_toolCallId, params) => {
        const data = params as { id: unknown; message: unknown; expected_version?: unknown };
        const result = await session.setInjectedMessagePayload(data);
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
        const result = await session.deleteInjectedMessagePayload(data);
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
