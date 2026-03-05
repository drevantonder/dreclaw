import { ToolLoopAgent, stepCountIs, tool, type ModelMessage } from "ai";
import { z } from "zod";
import { decodeEncryptionKey, decryptSecret } from "./crypto";
import {
  countVfsEntries,
  createGoogleOAuthState,
  deleteVfsEntry,
  deleteGoogleOAuthToken,
  deleteMemoryForChat,
  deleteOldMemoryEpisodes,
  getVfsEntry,
  getVfsRevision,
  getGoogleOAuthToken,
  insertMemoryEpisode,
  listVfsEntries,
  listActiveMemoryFacts,
  putVfsEntry,
  upsertSimilarMemoryFact,
  attachMemoryFactSource,
} from "./db";
import {
  executeCode,
  getCodeExecutionConfig,
  normalizeCodeRuntimeState,
  searchCodeRuntime,
  type CodeExecutionConfig,
  type CodeRuntimeState,
} from "./code-exec";
import {
  buildGoogleOAuthUrl,
  createOAuthStateToken,
  getGoogleOAuthConfig,
  refreshGoogleAccessToken,
} from "./google-oauth";
import { createZenModel } from "./llm/zen";
import { createWorkersModel } from "./llm/workers";
import { getMemoryConfig } from "./memory/config";
import { embedText } from "./memory/embeddings";
import { executeMemoryFind, executeMemoryRemove, executeMemorySave } from "./memory/execute-api";
import { retrieveMemoryContext } from "./memory/retrieve";
import { runMemoryReflection, buildMemoryId } from "./memory/reflection";
import { extractFacts, scoreSalience } from "./memory/salience";
import { upsertFactVector, deleteFactVectors } from "./memory/vectorize";
import { fetchImageAsDataUrl, sendTelegramMessage, sendTelegramMessageDraft } from "./telegram";
import {
  OPENCODE_GO_BASE_URL,
  OPENCODE_ZEN_BASE_URL,
  type Env,
  type ProgressMode,
  type SessionRequest,
  type SessionResponse,
} from "./types";

type SessionHistoryEntry = { role: "user" | "assistant" | "tool"; content: string };

interface SessionState {
  history: SessionHistoryEntry[];
  memoryTurns?: number;
  prefs?: {
    progressMode?: ProgressMode;
    showThinking?: boolean;
  };
  codeRuntime?: CodeRuntimeState;
}

interface RuntimeConfig {
  provider: "opencode" | "opencode-go" | "workers";
  model: string;
  baseUrl?: string;
  apiKey?: string;
  aiBinding?: Ai;
}

interface AgentRunResult {
  finalText: string;
  toolTranscripts: string[];
  interstitialAssistantTexts: string[];
}

const SYSTEM_PROMPT =
  "Memory is persistent and managed automatically by the runtime. Treat retrieved memory as high-signal context and keep replies grounded. execute supports async/await, network requests via fetch, and explicit memory APIs (memory.find, memory.save, memory.remove) in the QuickJS runtime. search is a local runtime/package introspection tool (not a web search engine). Be creative and resourceful: if you hit limitations, attempt safe novel approaches and fallback strategies with the tools available. Prefer the latest current information and verify time-sensitive facts with tools when possible.";
const GOOGLE_OAUTH_DEFAULT_PRINCIPAL = "default";
const TELEGRAM_DRAFT_MIN_INTERVAL_MS = 600;
const TELEGRAM_DRAFT_MIN_DELTA_CHARS = 80;
const MEMORY_FACT_TOP_K = 6;
const MEMORY_EPISODE_TOP_K = 4;

export class SessionRuntime implements DurableObject {
  private readonly state: DurableObjectState;
  private readonly env: Env;
  private loaded = false;
  private stateData: SessionState = { history: [] };
  private activeChatId: number | null = null;

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
    this.stateData.memoryTurns = Number.isFinite(this.stateData.memoryTurns) ? Math.max(0, Math.trunc(this.stateData.memoryTurns ?? 0)) : 0;
    this.stateData.prefs = normalizePrefs(this.stateData.prefs);
    this.stateData.codeRuntime = normalizeCodeRuntimeState(this.stateData.codeRuntime);
    this.loaded = true;
  }

  private async save(): Promise<void> {
    await this.state.storage.put("session-state", this.stateData);
  }

  private async handleMessage(payload: SessionRequest): Promise<SessionResponse> {
    this.activeChatId = payload.message.chat.id;
    await this.migrateLegacyCustomContext(payload.message.chat.id);
    const userText = payload.message.text ?? payload.message.caption ?? "";
    const imageBlocks = await this.loadImages(payload.message);
    const text = userText.trim();

    if (text.startsWith("/factory-reset")) {
      await this.deleteMemoryData(payload.message.chat.id);
      this.stateData = {
        history: [],
        memoryTurns: 0,
        prefs: normalizePrefs(this.stateData.prefs),
        codeRuntime: normalizeCodeRuntimeState(undefined),
      };
      await this.save();
      return { ok: true, text: "Factory reset complete. Defaults restored." };
    }

    if (text.startsWith("/reset")) {
      this.stateData = {
        history: [],
        memoryTurns: this.stateData.memoryTurns ?? 0,
        prefs: normalizePrefs(this.stateData.prefs),
        codeRuntime: this.getCodeRuntimeState(),
      };
      await this.save();
      return { ok: true, text: "Session reset. Conversation context cleared." };
    }

    if (text.startsWith("/status")) {
      const authReady = await this.workerAuthReady();
      const debugEnabled = this.getProgressMode() === "debug";
      const codeRuntime = this.getCodeRuntimeState();
      const codeConfig = this.getCodeExecutionConfig();
      const provider = this.getProvider();
      const memory = this.getMemoryConfigSafe();
      const vfsCount = await countVfsEntries(this.env.DRECLAW_DB);
      const factCount = memory.enabled
        ? (await listActiveMemoryFacts(this.env.DRECLAW_DB, payload.message.chat.id, 200)).length
        : 0;
      const summary = [
        `model: ${this.getModelName(provider)}`,
        `provider: ${provider}`,
        "session: healthy",
        `provider_auth: ${authReady ? "present" : "missing"}`,
        `debug: ${debugEnabled ? "on" : "off"}`,
        `history_messages: ${this.stateData.history.length}`,
        `memory_enabled: ${memory.enabled ? "yes" : "no"}`,
        `memory_facts: ${factCount}`,
        `memory_turns: ${this.stateData.memoryTurns ?? 0}`,
        `code_exec_enabled: ${codeConfig.codeExecEnabled ? "yes" : "no"}`,
        `installed_packages: ${codeRuntime.installedPackages.length}`,
        `vfs_files: ${vfsCount}`,
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

    if (text.startsWith("/google")) {
      return this.handleGoogleCommand(text, payload.message.chat.id, payload.message.from?.id ?? 0);
    }

    const runtime = this.getRuntimeConfig();
    const progress = new TelegramProgressReporter({
      token: this.env.TELEGRAM_BOT_TOKEN,
      chatId: payload.message.chat.id,
      mode: this.getProgressMode(),
      showThinking: this.shouldShowThinking(),
    });

    const draftReporter = new TelegramDraftReporter({
      token: this.env.TELEGRAM_BOT_TOKEN,
      chatId: payload.message.chat.id,
      draftId: buildTelegramDraftId(payload.updateId),
    });
    const run = await this.runAgentLoop(runtime, text, imageBlocks, progress, draftReporter, payload.message.chat.id);
    const responseText = run.finalText.trim() || "(empty response)";
    this.pushHistory({ role: "user", content: text || "[image]" });
    for (const interstitialText of run.interstitialAssistantTexts) {
      this.pushHistory({ role: "assistant", content: interstitialText });
    }
    for (const transcript of run.toolTranscripts) {
      this.pushHistory({ role: "tool", content: transcript });
    }
    this.pushHistory({ role: "assistant", content: responseText });

    await this.persistMemoryTurn({
      chatId: payload.message.chat.id,
      userText: text || "[image]",
      assistantText: responseText,
      interstitialAssistantTexts: run.interstitialAssistantTexts,
      toolTranscripts: run.toolTranscripts,
    });

    await this.save();
    return { ok: true, text: responseText };
  }

  private async runAgentLoop(
    runtime: RuntimeConfig,
    userText: string,
    imageBlocks: string[],
    progress: TelegramProgressReporter,
    draftReporter: TelegramDraftReporter,
    chatId: number,
  ): Promise<AgentRunResult> {
    const model = this.createModel(runtime);
    const historyContext = renderHistoryContext(this.stateData.history);
    const nowIso = new Date().toISOString();
    const promptSections = [SYSTEM_PROMPT, `Current date/time (UTC): ${nowIso}`];
    if (historyContext) {
      promptSections.push(`Recent context:\n${historyContext}`);
    }
    const memoryContext = await this.renderMemoryContext(chatId, userText);
    if (memoryContext) {
      promptSections.push(`Memory context:\n${memoryContext}`);
    }

    const toolTranscripts: string[] = [];
    const interstitialAssistantTexts: string[] = [];
    const agent = new ToolLoopAgent({
      model,
      tools: createAgentTools(this, progress, toolTranscripts),
      stopWhen: stepCountIs(8),
    });

    const sentInterstitialStepNumbers = new Set<number>();
    const sendInterstitial = async (stepNumber: number, rawText: string): Promise<void> => {
      const stepText = rawText.trim();
      if (!stepText) return;
      if (stepNumber >= 0 && sentInterstitialStepNumbers.has(stepNumber)) return;
      if (stepNumber >= 0) sentInterstitialStepNumbers.add(stepNumber);
      interstitialAssistantTexts.push(stepText);
      try {
        await sendTelegramMessage(this.env.TELEGRAM_BOT_TOKEN, chatId, stepText);
      } catch (error) {
        console.warn("telegram-interstitial-send-failed", {
          chatId,
          error: error instanceof Error ? error.message : String(error ?? "unknown"),
        });
      }
    };

    let currentStepNumber = -1;
    let currentStepText = "";
    let currentStepHasToolCall = false;

    const stream = await agent.stream({
      messages: buildAgentMessages(promptSections.join("\n\n"), userText, imageBlocks),
      experimental_onToolCallStart: async (event) => {
        const stepNumber = typeof event.stepNumber === "number" ? event.stepNumber : -1;
        const stepText = extractAssistantTextForToolCall(event.messages);
        if (stepText) {
          await sendInterstitial(stepNumber, stepText);
          return;
        }
        if (stepNumber >= 0 && stepNumber === currentStepNumber) {
          await sendInterstitial(stepNumber, currentStepText);
        }
      },
    });

    for await (const part of stream.fullStream) {
      const type = (part as { type?: unknown }).type;
      if (type === "start-step") {
        currentStepNumber += 1;
        currentStepText = "";
        currentStepHasToolCall = false;
        continue;
      }
      if (type === "text-delta") {
        const delta = (part as { text?: unknown }).text;
        if (typeof delta === "string" && delta) {
          currentStepText += delta;
          await draftReporter.onTextDelta(delta);
          if (currentStepHasToolCall) {
            await sendInterstitial(currentStepNumber, currentStepText);
          }
        }
        continue;
      }
      if (type === "tool-call") {
        currentStepHasToolCall = true;
        await sendInterstitial(currentStepNumber, currentStepText);
        continue;
      }
      if (type === "finish-step") {
        if (currentStepHasToolCall) {
          await sendInterstitial(currentStepNumber, currentStepText);
        }
      }
    }
    await draftReporter.flush();

    const response = await stream.response;
    await progress.sendThinkingBlocks(extractThinkingBlocks(response.messages));
    const generatedText = await stream.text;
    const finalText = typeof generatedText === "string" ? generatedText.trim() : "";
    return { finalText: finalText || "(empty response)", toolTranscripts, interstitialAssistantTexts };
  }

  private async handleGoogleCommand(text: string, chatId: number, telegramUserId: number): Promise<SessionResponse> {
    const parts = text.split(/\s+/).map((item) => item.trim()).filter(Boolean);
    const action = parts[1]?.toLowerCase() ?? "";
    if (!action || action === "help") {
      return {
        ok: true,
        text: [
          "Google OAuth commands:",
          "/google connect - link your Google account",
          "/google status - show link status and scopes",
          "/google disconnect - remove saved token",
        ].join("\n"),
      };
    }

    if (action === "connect") {
      const config = getGoogleOAuthConfig(this.env);
      const state = createOAuthStateToken();
      const now = new Date();
      const expiresAt = new Date(now.getTime() + 10 * 60 * 1000).toISOString();
      await createGoogleOAuthState(this.env.DRECLAW_DB, {
        state,
        chatId,
        telegramUserId,
        expiresAt,
        createdAt: now.toISOString(),
      });
      const url = buildGoogleOAuthUrl(config, state);
      return {
        ok: true,
        text: [
          "Open this URL to connect Google:",
          url,
          "This link expires in 10 minutes.",
        ].join("\n"),
      };
    }

    if (action === "status") {
      const token = await getGoogleOAuthToken(this.env.DRECLAW_DB, GOOGLE_OAUTH_DEFAULT_PRINCIPAL);
      if (!token) {
        return { ok: true, text: "google_oauth: not linked\nrun: /google connect" };
      }
      return {
        ok: true,
        text: [
          "google_oauth: linked",
          `scopes: ${token.scopes || "unknown"}`,
          `updated_at: ${token.updatedAt}`,
        ].join("\n"),
      };
    }

    if (action === "disconnect") {
      const deleted = await deleteGoogleOAuthToken(this.env.DRECLAW_DB, GOOGLE_OAUTH_DEFAULT_PRINCIPAL);
      return {
        ok: true,
        text: deleted ? "Google account disconnected." : "No linked Google account found.",
      };
    }

    return { ok: true, text: "Unknown /google command. Use /google help" };
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
    const provider = this.getProvider();
    if (provider === "workers") {
      return Boolean(this.env.AI);
    }
    return Boolean(this.getApiKey());
  }

  private getRuntimeConfig(): RuntimeConfig {
    const provider = this.getProvider();
    const model = this.getModelName(provider);

    if (provider === "workers") {
      if (!this.env.AI) throw new Error("Missing AI binding");
      return { provider, model, aiBinding: this.env.AI };
    }

    const apiKey = this.getApiKey();
    if (!apiKey) throw new Error("Missing OPENCODE_API_KEY");

    const baseUrl = this.getBaseUrl(provider);
    return { provider, model, apiKey, baseUrl };
  }

  private getProvider(): "opencode" | "opencode-go" | "workers" {
    const provider = this.env.AI_PROVIDER?.trim().toLowerCase();
    if (provider === "workers") return "workers";
    if (provider === "opencode-go" || provider === "go") return "opencode-go";
    return "opencode";
  }

  private getModelName(provider: "opencode" | "opencode-go" | "workers"): string {
    const model = this.env.MODEL?.trim();
    if (model) return model;
    if (provider === "workers") return "@cf/zai-org/glm-4.7-flash";
    throw new Error("Missing MODEL");
    return model;
  }

  private getApiKey(): string | undefined {
    return this.env.OPENCODE_API_KEY?.trim();
  }

  private getBaseUrl(provider: "opencode" | "opencode-go" | "workers"): string {
    const configured = this.env.BASE_URL?.trim();
    if (configured) return configured;
    if (provider === "opencode-go") return OPENCODE_GO_BASE_URL;
    return OPENCODE_ZEN_BASE_URL;
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
        vfs: {
          readFile: async (path) => {
            const normalized = normalizeSessionVfsPath(path);
            const row = await getVfsEntry(this.env.DRECLAW_DB, normalized);
            return row ? row.content : null;
          },
          writeFile: async (path, content, overwrite) => {
            const normalized = normalizeSessionVfsPath(path);
            const config = this.getCodeExecutionConfig();
            const sizeBytes = new TextEncoder().encode(content).byteLength;
            if (sizeBytes > config.limits.vfsMaxFileBytes) {
              return { ok: false, code: "VFS_LIMIT_EXCEEDED" };
            }

            const existing = await getVfsEntry(this.env.DRECLAW_DB, normalized);
            if (!existing) {
              const count = await countVfsEntries(this.env.DRECLAW_DB);
              if (count >= config.limits.vfsMaxFiles) {
                return { ok: false, code: "VFS_LIMIT_EXCEEDED" };
              }
            }

            const nowIso = new Date().toISOString();
            const result = await putVfsEntry(this.env.DRECLAW_DB, {
              path: normalized,
              content,
              sizeBytes,
              sha256: await sha256Hex(content),
              nowIso,
              overwrite,
            });
            if (!result.ok) {
              return { ok: false, code: result.code };
            }
            return { ok: true };
          },
          listFiles: async (prefix, limit) => {
            const normalizedPrefix = normalizeSessionVfsPath(prefix || "/");
            const rows = await listVfsEntries(this.env.DRECLAW_DB, normalizedPrefix, Math.max(1, limit));
            return rows.map((item) => item.path);
          },
          removeFile: async (path) => {
            const normalized = normalizeSessionVfsPath(path);
            return deleteVfsEntry(this.env.DRECLAW_DB, normalized, new Date().toISOString());
          },
          revision: async () => getVfsRevision(this.env.DRECLAW_DB),
        },
        memory: {
          find: async (input) => this.executeMemoryFindPayload(input),
          save: async (input) => this.executeMemorySavePayload(input),
          remove: async (input) => this.executeMemoryRemovePayload(input),
        },
        googleAuth: {
          getAccessToken: async () => this.getGoogleAccessToken(),
          allowedServices: ["gmail", "drive", "sheets", "docs", "calendar"],
        },
      },
    );
  }

  private async getGoogleAccessToken(): Promise<{ accessToken: string; scope: string }> {
    const token = await getGoogleOAuthToken(this.env.DRECLAW_DB, GOOGLE_OAUTH_DEFAULT_PRINCIPAL);
    if (!token) {
      throw new Error("Google account not linked. Run /google connect");
    }
    const key = decodeEncryptionKey(String(this.env.GOOGLE_OAUTH_ENCRYPTION_KEY ?? ""));
    const refreshToken = await decryptSecret(
      {
        ciphertext: token.refreshTokenCiphertext,
        nonce: token.nonce,
      },
      key,
    );
    const oauthConfig = getGoogleOAuthConfig(this.env);
    const timeoutMs = this.getCodeExecutionConfig().limits.netRequestTimeoutMs;
    const refreshed = await refreshGoogleAccessToken(oauthConfig, refreshToken, timeoutMs);
    return {
      accessToken: refreshed.accessToken,
      scope: refreshed.scope,
    };
  }

  private async migrateLegacyCustomContext(chatId: number): Promise<void> {
    const carrier = this.stateData as unknown as Record<string, unknown>;
    if (!("customContext" in carrier)) return;

    const legacyItems = readLegacyCustomContextItems(carrier.customContext);
    delete carrier.customContext;

    const memory = this.getMemoryConfigSafe();
    if (!memory.enabled || !legacyItems.length) return;

    const nowIso = new Date().toISOString();
    for (const item of legacyItems) {
      const episodeId = buildMemoryId("episode");
      const content = `${item.id}: ${item.text}`;
      await insertMemoryEpisode(this.env.DRECLAW_DB, {
        id: episodeId,
        chatId,
        role: "tool",
        content,
        salience: 1,
        createdAt: nowIso,
      });

      const kind = item.id === "identity" || item.id === "soul" ? "identity" : "fact";
      const saved = await upsertSimilarMemoryFact(this.env.DRECLAW_DB, {
        id: buildMemoryId("fact"),
        chatId,
        kind,
        text: item.text,
        confidence: 0.95,
        nowIso,
      });
      await attachMemoryFactSource(this.env.DRECLAW_DB, saved.fact.id, episodeId, nowIso);
      if (saved.created) {
        const vector = await embedText(this.env, memory.embeddingModel, saved.fact.text);
        await upsertFactVector(this.env, saved.fact.id, chatId, vector);
      }
    }
    await this.save();
  }

  private getMemoryConfigSafe() {
    try {
      return getMemoryConfig(this.env);
    } catch (error) {
      const detail = compactErrorMessage(error);
      throw new Error(`Memory config error: ${detail}`);
    }
  }

  private getSessionChatId(): number {
    if (typeof this.activeChatId === "number" && Number.isFinite(this.activeChatId)) {
      return Math.trunc(this.activeChatId);
    }
    const raw = Number(this.state.id.toString());
    if (!Number.isFinite(raw)) {
      throw new Error("Unable to resolve session chat id");
    }
    return Math.trunc(raw);
  }

  private async executeMemoryFindPayload(input: unknown): Promise<unknown> {
    const memory = this.getMemoryConfigSafe();
    if (!memory.enabled) throw new Error("Memory is disabled");
    return executeMemoryFind({
      env: this.env,
      db: this.env.DRECLAW_DB,
      chatId: this.getSessionChatId(),
      embeddingModel: memory.embeddingModel,
      payload: input,
    });
  }

  private async executeMemorySavePayload(input: unknown): Promise<unknown> {
    const memory = this.getMemoryConfigSafe();
    if (!memory.enabled) throw new Error("Memory is disabled");
    return executeMemorySave({
      env: this.env,
      db: this.env.DRECLAW_DB,
      chatId: this.getSessionChatId(),
      embeddingModel: memory.embeddingModel,
      payload: input,
    });
  }

  private async executeMemoryRemovePayload(input: unknown): Promise<unknown> {
    const memory = this.getMemoryConfigSafe();
    if (!memory.enabled) throw new Error("Memory is disabled");
    return executeMemoryRemove({
      env: this.env,
      db: this.env.DRECLAW_DB,
      chatId: this.getSessionChatId(),
      payload: input,
    });
  }

  private async renderMemoryContext(chatId: number, query: string): Promise<string> {
    const memory = this.getMemoryConfigSafe();
    if (!memory.enabled) return "";

    const retrieved = await retrieveMemoryContext({
      env: this.env,
      db: this.env.DRECLAW_DB,
      chatId,
      query,
      embeddingModel: memory.embeddingModel,
      factTopK: MEMORY_FACT_TOP_K,
      episodeTopK: MEMORY_EPISODE_TOP_K,
    });
    if (!retrieved.facts.length && !retrieved.episodes.length) return "";

    const lines: string[] = [];
    if (retrieved.facts.length) {
      lines.push("Facts:");
      for (const fact of retrieved.facts) {
        lines.push(`- [${fact.kind}] ${fact.text}`);
      }
    }
    if (retrieved.episodes.length) {
      lines.push("Recent episodes:");
      for (const episode of retrieved.episodes) {
        lines.push(`- ${episode.role}: ${truncateForLog(episode.content, 220)}`);
      }
    }

    const joined = lines.join("\n");
    const maxChars = memory.maxInjectTokens * 4;
    if (joined.length <= maxChars) return joined;
    return `${joined.slice(0, Math.max(0, maxChars - 1))}…`;
  }

  private async persistMemoryTurn(params: {
    chatId: number;
    userText: string;
    assistantText: string;
    interstitialAssistantTexts: string[];
    toolTranscripts: string[];
  }): Promise<void> {
    const memory = this.getMemoryConfigSafe();
    if (!memory.enabled) return;
    const nowIso = new Date().toISOString();

    const episodeInputs: Array<{ role: "user" | "assistant" | "tool"; content: string }> = [
      { role: "user", content: params.userText },
      ...params.interstitialAssistantTexts.map((content) => ({ role: "assistant" as const, content })),
      ...params.toolTranscripts.map((content) => ({ role: "tool" as const, content })),
      { role: "assistant", content: params.assistantText },
    ];

    for (const entry of episodeInputs) {
      const salience = scoreSalience(entry.content);
      if (!salience.shouldStoreEpisode) continue;
      const episodeId = buildMemoryId("episode");
      await insertMemoryEpisode(this.env.DRECLAW_DB, {
        id: episodeId,
        chatId: params.chatId,
        role: entry.role,
        content: entry.content,
        salience: salience.score,
        createdAt: nowIso,
      });
      if (!salience.shouldStoreFact) continue;
      const facts = extractFacts(entry.content);
      for (const extracted of facts) {
        const saved = await upsertSimilarMemoryFact(this.env.DRECLAW_DB, {
          id: buildMemoryId("fact"),
          chatId: params.chatId,
          kind: extracted.kind,
          text: extracted.text,
          confidence: extracted.confidence,
          nowIso,
        });
        await attachMemoryFactSource(this.env.DRECLAW_DB, saved.fact.id, episodeId, nowIso);
        if (saved.created) {
          const vector = await embedText(this.env, memory.embeddingModel, saved.fact.text);
          await upsertFactVector(this.env, saved.fact.id, params.chatId, vector);
        }
      }
    }

    this.stateData.memoryTurns = (this.stateData.memoryTurns ?? 0) + 1;
    if ((this.stateData.memoryTurns ?? 0) % memory.reflectionEveryTurns === 0) {
      const reflection = await runMemoryReflection({
        db: this.env.DRECLAW_DB,
        chatId: params.chatId,
        limit: 24,
        nowIso,
      });
      if (reflection.writtenFacts > 0) {
        const facts = await listActiveMemoryFacts(this.env.DRECLAW_DB, params.chatId, 200);
        for (const fact of facts) {
          const vector = await embedText(this.env, memory.embeddingModel, fact.text);
          await upsertFactVector(this.env, fact.id, params.chatId, vector);
        }
      }
    }

    const cutoff = new Date(Date.now() - memory.retentionDays * 24 * 60 * 60 * 1000).toISOString();
    await deleteOldMemoryEpisodes(this.env.DRECLAW_DB, params.chatId, cutoff);
  }

  private async deleteMemoryData(chatId: number): Promise<void> {
    const memory = this.getMemoryConfigSafe();
    if (!memory.enabled) return;
    const existingFacts = await listActiveMemoryFacts(this.env.DRECLAW_DB, chatId, 500);
    await deleteMemoryForChat(this.env.DRECLAW_DB, chatId);
    await deleteFactVectors(
      this.env,
      existingFacts.map((item) => item.id),
    );
  }
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

function readLegacyCustomContextItems(input: unknown): Array<{ id: string; text: string }> {
  if (!input || typeof input !== "object") return [];
  const state = input as { items?: unknown };
  if (!Array.isArray(state.items)) return [];

  const items: Array<{ id: string; text: string }> = [];
  for (const row of state.items) {
    if (!row || typeof row !== "object") continue;
    const item = row as { id?: unknown; text?: unknown };
    const id = typeof item.id === "string" ? item.id.trim().toLowerCase() : "";
    const text = typeof item.text === "string" ? item.text.trim() : "";
    if (!id || !text) continue;
    items.push({ id, text });
  }
  return items;
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
  toolTranscripts: string[],
) {
  async function runTool<T>(
    name: string,
    args: Record<string, unknown>,
    execute: () => Promise<T> | T,
  ): Promise<T | { ok: false; error: string }> {
    await progress.onToolPreview(name, args);
    try {
      const result = await execute();
      toolTranscripts.push(renderToolTranscript(name, true, args, result));
      await progress.onStepSummary({
        tools: [name],
        okCount: 1,
        errorCount: 0,
        resultPreview: name === "execute" ? formatExecuteResultPreview(result) : undefined,
      });
      return result;
    } catch (error) {
      const detail = redactSensitiveText(compactErrorMessage(error));
      await progress.onStepSummary({ tools: [name], okCount: 0, errorCount: 1, error: detail });
      toolTranscripts.push(renderToolTranscript(name, false, args, undefined, detail));
      console.error("tool-call-failed", { tool: name, error: detail });
      return { ok: false, error: detail };
    }
  }

  return {
    search: tool({
      description: "Inspect local QuickJS runtime capabilities and installed packages (not web search)",
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
  };
}

function renderToolTranscript(
  name: string,
  ok: boolean,
  args: Record<string, unknown>,
  output?: unknown,
  error?: string,
): string {
  const serializedArgs = redactSensitiveText(serializeToolArgsForHistory(name, args));
  const outputText = redactSensitiveText(truncateForLog(serializeUnknown(output), 1200));
  return [
    `tool=${name}`,
    `ok=${ok}`,
    `args=${serializedArgs}`,
    ok ? `output=${outputText}` : `error=${error || "tool failed"}`,
  ].join("\n");
}

function serializeToolArgsForHistory(name: string, args: Record<string, unknown>): string {
  if (name === "execute") {
    const code = typeof args.code === "string" ? truncateForLog(args.code, 1200) : "";
    const input = Object.prototype.hasOwnProperty.call(args, "input") ? truncateForLog(serializeUnknown(args.input), 320) : "";
    return JSON.stringify({ code, ...(input ? { input } : {}) });
  }
  return truncateForLog(serializeUnknown(args), 700);
}

function serializeUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value ?? "");
  }
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
    resultPreview?: string;
  }): Promise<void> {
    if (this.mode === "compact") return;
    const names = params.tools.join(", ");
    const base = `Step: tools=[${names}] ok=${params.okCount} error=${params.errorCount}`;
    const detail = params.error ? ` ${truncateForLog(params.error, 220)}` : "";
    const lines = [`${base}${detail}`];
    if (params.resultPreview) lines.push(params.resultPreview);
    await this.safeSendMessage(lines.join("\n"));
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

class TelegramDraftReporter {
  private readonly token: string;
  private readonly chatId: number;
  private readonly draftId: number;
  private enabled = true;
  private assembledText = "";
  private lastSentText = "";
  private lastSentAt = 0;

  constructor(params: { token: string; chatId: number; draftId: number }) {
    this.token = params.token;
    this.chatId = params.chatId;
    this.draftId = params.draftId;
  }

  async onTextDelta(delta: string): Promise<void> {
    if (!this.enabled) return;
    const next = String(delta ?? "");
    if (!next) return;
    this.assembledText += next;
    await this.maybeSend(false);
  }

  async flush(): Promise<void> {
    if (!this.enabled) return;
    await this.maybeSend(true);
  }

  private async maybeSend(force: boolean): Promise<void> {
    const trimmed = this.assembledText.trim();
    if (!trimmed) return;
    if (trimmed === this.lastSentText) return;

    const now = Date.now();
    const deltaChars = trimmed.length - this.lastSentText.length;
    const elapsed = now - this.lastSentAt;
    const shouldSend = force || deltaChars >= TELEGRAM_DRAFT_MIN_DELTA_CHARS || elapsed >= TELEGRAM_DRAFT_MIN_INTERVAL_MS;
    if (!shouldSend) return;

    try {
      await sendTelegramMessageDraft(this.token, this.chatId, this.draftId, trimmed);
      this.lastSentText = trimmed;
      this.lastSentAt = now;
    } catch (error) {
      this.enabled = false;
      console.warn("telegram-draft-send-failed", {
        chatId: this.chatId,
        draftId: this.draftId,
        error: error instanceof Error ? error.message : String(error ?? "unknown"),
      });
    }
  }
}

function buildTelegramDraftId(updateId: number): number {
  const numericUpdateId = Number.isFinite(updateId) ? Math.trunc(updateId) : 0;
  const normalized = Math.abs(numericUpdateId) % 2_000_000_000;
  return normalized === 0 ? 1 : normalized;
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
  return null;
}

function formatExecuteResultPreview(output: unknown): string {
  const value = output && typeof output === "object" ? (output as Record<string, unknown>) : null;
  const result = value && Object.prototype.hasOwnProperty.call(value, "result") ? value.result : output;
  const resultText = redactSensitiveText(truncateForLog(serializeUnknown(result), 420));
  const lines = [`Result: ${resultText || "(no output)"}`];

  if (value && Array.isArray(value.logs)) {
    const logItems = value.logs
      .filter((item): item is { level?: unknown; text?: unknown } => Boolean(item && typeof item === "object"))
      .slice(0, 3)
      .map((item) => {
        const level = item.level === "warn" || item.level === "error" ? item.level : "log";
        const text = redactSensitiveText(truncateForLog(String(item.text ?? ""), 120));
        return text ? `[${level}] ${text}` : "";
      })
      .filter(Boolean);
    if (logItems.length) {
      lines.push(`Logs: ${truncateForLog(logItems.join(" | "), 420)}`);
    }
  }

  return lines.join("\n");
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

function extractAssistantTextForToolCall(messages: unknown[]): string {
  if (!Array.isArray(messages)) return "";
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as { role?: unknown; content?: unknown };
    if (message.role !== "assistant") continue;
    const content = message.content;
    if (typeof content === "string") return content.trim();
    if (!Array.isArray(content)) return "";
    const text = content
      .map((item) => {
        if (!item || typeof item !== "object") return "";
        const type = (item as { type?: unknown }).type;
        if (type !== "text") return "";
        const value = (item as { text?: unknown }).text;
        return typeof value === "string" ? value : "";
      })
      .join("\n")
      .trim();
    return text;
  }
  return "";
}

function normalizeSessionVfsPath(rawPath: string): string {
  const input = String(rawPath ?? "").trim();
  if (!input) throw new Error("VFS_INVALID_PATH: path is required");
  const path = input.startsWith("vfs:/") ? input.slice(4) : input;
  if (!path.startsWith("/")) {
    throw new Error("VFS_INVALID_PATH: path must be absolute");
  }
  const parts = path.split("/");
  const normalized: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!normalized.length) throw new Error("VFS_INVALID_PATH: path traversal is not allowed");
      normalized.pop();
      continue;
    }
    if (part.includes("\\")) throw new Error("VFS_INVALID_PATH: invalid separator");
    normalized.push(part);
  }
  return `/${normalized.join("/")}`;
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
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
