import { ToolLoopAgent, stepCountIs, tool, type ModelMessage } from "ai";
import { z } from "zod";
import {
  executeCode,
  getCodeExecutionConfig,
  normalizeCodeRuntimeState,
  searchCodeRuntime,
  type CodeExecutionConfig,
  type CodeRuntimeState,
} from "./code-exec";
import { createZenModel } from "./llm/zen";
import { createWorkersModel } from "./llm/workers";
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
  codeRuntime?: CodeRuntimeState;
}

interface RuntimeConfig {
  provider: "zen" | "workers";
  model: string;
  baseUrl?: string;
  apiKey?: string;
  aiBinding?: Ai;
}

interface AgentRunResult {
  finalText: string;
  toolErrors: string[];
}

const SYSTEM_PROMPT =
  "custom_context is persistent editable startup context. Keep it current using provided tools. execute supports async/await and network requests via fetch in the QuickJS runtime.";
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
    this.stateData.customContext = normalizeCustomContextState(this.stateData.customContext);
    this.stateData.codeRuntime = normalizeCodeRuntimeState(this.stateData.codeRuntime);
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
        codeRuntime: normalizeCodeRuntimeState(undefined),
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
        codeRuntime: this.getCodeRuntimeState(),
      };
      await this.save();
      return { ok: true, text: "Session reset. Conversation context cleared." };
    }

    if (text.startsWith("/status")) {
      const authReady = await this.workerAuthReady();
      const customContext = this.getCustomContextState();
      const debugEnabled = this.getProgressMode() === "debug";
      const codeRuntime = this.getCodeRuntimeState();
      const codeConfig = this.getCodeExecutionConfig();
      const provider = this.getProvider();
      const summary = [
        `model: ${this.getModelName(provider)}`,
        `provider: ${provider}`,
        "session: healthy",
        `provider_auth: ${authReady ? "present" : "missing"}`,
        `debug: ${debugEnabled ? "on" : "off"}`,
        `history_messages: ${this.stateData.history.length}`,
        `custom_context_version: ${customContext.version}`,
        `custom_context_count: ${customContext.items.length}`,
        `code_exec_enabled: ${codeConfig.codeExecEnabled ? "yes" : "no"}`,
        `installed_packages: ${codeRuntime.installedPackages.length}`,
      ].join("\n");
      return { ok: true, text: summary };
    }

    if (text.startsWith("/debug")) {
      const nextDebug = parseDebugFlag(text);
      if (nextDebug === null) {
        const current = this.getProgressMode() === "debug" ? "on" : "off";
        return { ok: true, text: `debug: ${current}\nusage: /debug on|off` };
      }
      this.stateData.prefs = {
        ...normalizePrefs(this.stateData.prefs),
        progressMode: nextDebug ? "debug" : "compact",
      };
      await this.save();
      return { ok: true, text: `debug ${nextDebug ? "enabled" : "disabled"}.` };
    }

    if (text.startsWith("/show-thinking")) {
      const nextThinking = parseThinkingFlag(text);
      if (nextThinking === null) {
        const current = this.shouldShowThinking() ? "on" : "off";
        return { ok: true, text: `show-thinking: ${current}\nusage: /show-thinking on|off` };
      }
      this.stateData.prefs = {
        ...normalizePrefs(this.stateData.prefs),
        showThinking: nextThinking,
      };
      await this.save();
      return { ok: true, text: `show-thinking ${nextThinking ? "enabled" : "disabled"}.` };
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
    const model = this.createModel(runtime);
    const historyContext = renderHistoryContext(this.stateData.history);
    const customContext = this.renderCustomContextXml();
    const promptSections = [SYSTEM_PROMPT];
    if (customContext) {
      promptSections.push(`Custom context:\n${customContext}`);
    }
    if (historyContext) {
      promptSections.push(`Recent context:\n${historyContext}`);
    }

    const toolErrors: string[] = [];
    const agent = new ToolLoopAgent({
      model,
      tools: createAgentTools(this, progress, toolErrors),
      stopWhen: stepCountIs(8),
    });

    const result = await agent.generate({
      messages: buildAgentMessages(promptSections.join("\n\n"), userText, imageBlocks),
    });

    await progress.sendThinkingBlocks(extractThinkingBlocks(result.response.messages));
    const finalText = typeof result.text === "string" ? result.text.trim() : "";
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
    if (this.getProvider() === "workers") {
      return Boolean(this.env.AI);
    }
    return Boolean(this.env.OPENCODE_ZEN_API_KEY?.trim());
  }

  private getRuntimeConfig(): RuntimeConfig {
    const provider = this.getProvider();
    const model = this.getModelName(provider);

    if (provider === "workers") {
      if (!this.env.AI) throw new Error("Missing AI binding");
      return { provider, model, aiBinding: this.env.AI };
    }

    const apiKey = this.env.OPENCODE_ZEN_API_KEY?.trim();
    if (!apiKey) throw new Error("Missing OPENCODE_ZEN_API_KEY");

    const baseUrl = this.env.BASE_URL?.trim() || DEFAULT_BASE_URL;
    return { provider, model, apiKey, baseUrl };
  }

  private getProvider(): "zen" | "workers" {
    const provider = this.env.AI_PROVIDER?.trim().toLowerCase();
    if (provider === "workers") return "workers";
    return "zen";
  }

  private getModelName(provider: "zen" | "workers"): string {
    const model = this.env.MODEL?.trim();
    if (model) return model;
    if (provider === "workers") return "@cf/zai-org/glm-4.7-flash";
    throw new Error("Missing MODEL");
    return model;
  }

  private createModel(runtime: RuntimeConfig) {
    if (runtime.provider === "workers") {
      if (!runtime.aiBinding) throw new Error("Missing AI binding");
      return createWorkersModel(runtime.aiBinding, runtime.model);
    }
    if (!runtime.apiKey || !runtime.baseUrl) throw new Error("Missing Zen runtime config");
    return createZenModel({ model: runtime.model, apiKey: runtime.apiKey, baseUrl: runtime.baseUrl });
  }

  private getCodeRuntimeState(): CodeRuntimeState {
    const current = normalizeCodeRuntimeState(this.stateData.codeRuntime);
    this.stateData.codeRuntime = current;
    return current;
  }

  private getCodeExecutionConfig(): CodeExecutionConfig {
    return getCodeExecutionConfig(this.env as unknown as Record<string, string | undefined>);
  }

  searchCodePayload(payload: { query?: unknown }): unknown {
    return searchCodeRuntime(
      {
        query: typeof payload.query === "string" ? payload.query : "",
      },
      {
        config: this.getCodeExecutionConfig(),
        state: this.getCodeRuntimeState(),
        saveState: async () => undefined,
      },
    );
  }

  async executeCodePayload(payload: { code: unknown; input?: unknown }): Promise<unknown> {
    return executeCode(
      {
        code: typeof payload.code === "string" ? payload.code : "",
        input: payload.input,
      },
      {
        config: this.getCodeExecutionConfig(),
        state: this.getCodeRuntimeState(),
        saveState: async (next) => {
          this.stateData.codeRuntime = normalizeCodeRuntimeState(next);
          await this.save();
        },
      },
    );
  }
}

function normalizeCustomContextState(state: CustomContextState | undefined): CustomContextState {
  if (state) {
    return {
      version: Number.isFinite(state.version) && state.version > 0 ? Math.trunc(state.version) : 1,
      items: normalizeCustomContextItems(state.items),
    };
  }
  return {
    version: 1,
    items: cloneCustomContextItems(DEFAULT_CUSTOM_CONTEXT_ITEMS),
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

function buildAgentMessages(systemPrompt: string, userText: string, imageBlocks: string[]): ModelMessage[] {
  const parts: Array<{ type: "text"; text: string } | { type: "image"; image: string }> = [];
  const text = userText || "[image message]";
  parts.push({ type: "text", text });
  for (const image of imageBlocks) {
    parts.push({ type: "image", image });
  }

  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: imageBlocks.length ? parts : text },
  ];
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
  if (progressMode === "compact" || progressMode === "debug") {
    return { progressMode, showThinking };
  }
  if (progressMode === "verbose") return { progressMode: "compact", showThinking };
  return { progressMode: "compact", showThinking };
}

function parseDebugFlag(text: string): boolean | null {
  const [, rawFlag = ""] = text.trim().split(/\s+/, 2);
  const flag = rawFlag.toLowerCase();
  if (!flag) return null;
  if (flag === "on") return true;
  if (flag === "off") return false;
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

function createAgentTools(
  session: SessionRuntime,
  progress: TelegramProgressReporter,
  toolErrors: string[],
) {
  async function runTool<T>(
    name: string,
    args: Record<string, unknown>,
    execute: () => Promise<T> | T,
  ): Promise<T | { ok: false; error: string }> {
    await progress.onToolPreview(name, args);
    try {
      const result = await execute();
      await progress.onStepSummary({ tools: [name], okCount: 1, errorCount: 0 });
      return result;
    } catch (error) {
      const detail = redactSensitiveText(compactErrorMessage(error));
      await progress.onStepSummary({ tools: [name], okCount: 0, errorCount: 1, error: detail });
      toolErrors.push([`tool=${name}`, "ok=false", `error=${detail}`, `output=${detail}`].join("\n"));
      console.error("tool-call-failed", { tool: name, error: detail });
      return { ok: false, error: detail };
    }
  }

  return {
    search: tool({
      description: "Search runtime capabilities and installed packages",
      inputSchema: z.object({ query: z.string().optional() }),
      execute: async (params) =>
        runTool("search", params as Record<string, unknown>, async () => session.searchCodePayload({ query: params.query })),
    }),
    execute: tool({
      description: "Run JavaScript in QuickJS runtime (supports async/await and fetch)",
      inputSchema: z.object({ code: z.string(), input: z.unknown().optional() }),
      execute: async (params) =>
        runTool("execute", params as Record<string, unknown>, async () =>
          session.executeCodePayload({ code: params.code, input: params.input }),
        ),
    }),
    custom_context_get: tool({
      description: "Return current custom context and version",
      inputSchema: z.object({}),
      execute: async (params) =>
        runTool("custom_context_get", params as Record<string, unknown>, async () => session.getCustomContextPayload()),
    }),
    custom_context_set: tool({
      description: "Create or update one custom context entry by id",
      inputSchema: z.object({ id: z.string(), text: z.string(), expected_version: z.number().optional() }),
      execute: async (params) =>
        runTool("custom_context_set", params as Record<string, unknown>, async () => session.setCustomContextPayload(params)),
    }),
    custom_context_delete: tool({
      description: "Delete one custom context entry by id",
      inputSchema: z.object({ id: z.string(), expected_version: z.number().optional() }),
      execute: async (params) =>
        runTool("custom_context_delete", params as Record<string, unknown>, async () => session.deleteCustomContextPayload(params)),
    }),
  };
}

class TelegramProgressReporter {
  private readonly token: string;
  private readonly chatId: number;
  private readonly mode: ProgressMode;
  private readonly showThinking: boolean;
  private seenPreviews = new Set<string>();

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

  async sendThinkingBlocks(blocks: string[]): Promise<void> {
    if (!this.showThinking) return;
    for (const block of blocks) {
      const text = truncateForLog(block, 700);
      if (!text) continue;
      await this.safeSendMessage(`Thinking:\n${text}`);
    }
  }

  async onToolPreview(name: string, args: Record<string, unknown>): Promise<void> {
    if (this.mode === "compact") return;
    const preview = buildToolPreview(name, args);
    if (!preview) return;
    if (this.seenPreviews.has(preview.key)) return;
    this.seenPreviews.add(preview.key);
    await this.safeSendMessage(preview.text, preview.rawHtml ?? false);
  }

  async onStepSummary(params: {
    tools: string[];
    okCount: number;
    errorCount: number;
    error?: string;
  }): Promise<void> {
    if (this.mode === "compact") return;
    const names = params.tools.join(", ");
    const base = `Step: tools=[${names}] ok=${params.okCount} error=${params.errorCount}`;
    const detail = params.error ? ` ${truncateForLog(params.error, 220)}` : "";
    await this.safeSendMessage(`${base}${detail}`);
  }

  private async safeSendMessage(text: string, rawHtml = false): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;
    try {
      await sendTelegramMessage(this.token, this.chatId, trimmed, { rawHtml });
    } catch (error) {
      console.warn("telegram-progress-send-failed", {
        chatId: this.chatId,
        error: error instanceof Error ? error.message : String(error ?? "unknown"),
      });
    }
  }
}

function buildToolPreview(name: string, args: Record<string, unknown>): { key: string; text: string; rawHtml?: boolean } | null {
  if (name === "search") {
    const query = typeof args.query === "string" ? truncateForLog(args.query, 80) : "";
    if (!query) return { key: "search:runtime", text: "Searching runtime..." };
    return { key: `search:${query}`, text: `Searching \"${query}\"...` };
  }
  if (name === "execute") {
    const code = typeof args.code === "string" ? args.code.trim() : "";
    if (!code) {
      return { key: "execute:empty", text: "Running code snippet..." };
    }
    const snippet = truncateCodePreview(code, 1200);
    return {
      key: `execute:${snippet}`,
      rawHtml: true,
      text: `Executing JavaScript:\n<pre><code>${escapeHtml(snippet)}</code></pre>`,
    };
  }
  if (name === "custom_context_get") {
    return { key: "custom_context_get", text: "Checking saved context..." };
  }
  if (name === "custom_context_set") {
    const id = typeof args.id === "string" ? truncateForLog(args.id, 40) : "memory";
    return { key: `custom_context_set:${id}`, text: `Updating ${id}...` };
  }
  if (name === "custom_context_delete") {
    const id = typeof args.id === "string" ? truncateForLog(args.id, 40) : "memory";
    return { key: `custom_context_delete:${id}`, text: `Removing ${id}...` };
  }
  return null;
}

function truncateCodePreview(code: string, maxChars: number): string {
  if (code.length <= maxChars) return code;
  return `${code.slice(0, maxChars - 14)}\n// ...truncated`;
}

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function extractThinkingBlocks(messages: unknown[]): string[] {
  const blocks: string[] = [];
  for (const message of messages) {
    const role = (message as { role?: unknown })?.role;
    if (role !== "assistant") continue;
    const content = (message as { content?: unknown })?.content;
    if (!Array.isArray(content)) continue;
    for (const item of content) {
      if (!item || typeof item !== "object") continue;
      const type = (item as { type?: unknown }).type;
      if (type !== "thinking" && type !== "reasoning") continue;
      const textValue =
        (item as { thinking?: unknown }).thinking ??
        (item as { text?: unknown }).text ??
        (item as { reasoning?: unknown }).reasoning;
      if (typeof textValue !== "string") continue;
      const compact = textValue.trim();
      if (compact) blocks.push(compact);
    }
  }
  return blocks;
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
