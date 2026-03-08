import { ToolLoopAgent, generateText, stepCountIs, tool, type ModelMessage } from "ai";
import type { Thread, Message } from "chat";
import { z } from "zod";
import { decodeEncryptionKey, decryptSecret } from "../crypto";
import {
  attachMemoryFactSource,
  clearAllVfsEntries,
  countVfsEntries,
  createGoogleOAuthState,
  deleteGoogleOAuthToken,
  deleteMemoryForChat,
  deleteOldMemoryEpisodes,
  deleteVfsEntry,
  getGoogleOAuthToken,
  getPersistedRunStatus,
  getPersistedThreadControls,
  getVfsEntry,
  getVfsRevision,
  insertMemoryEpisode,
  listActiveMemoryFacts,
  listVfsEntries,
  putVfsEntry,
  setPersistedRunStatus,
  upsertSimilarMemoryFact,
} from "../db";
import {
  executeCode,
  getCodeExecutionConfig,
  normalizeCodeRuntimeState,
  searchCodeRuntime,
  type CodeRuntimeState,
} from "../code-exec";
import {
  buildGoogleOAuthUrl,
  createOAuthStateToken,
  getGoogleOAuthConfig,
  refreshGoogleAccessToken,
} from "../google-oauth";
import { createZenModel } from "../llm/zen";
import { createWorkersModel } from "../llm/workers";
import { getMemoryConfig } from "../memory/config";
import { embedText } from "../memory/embeddings";
import { executeMemoryFind, executeMemoryRemove, executeMemorySave } from "../memory/execute-api";
import { runMemoryReflection, buildMemoryId } from "../memory/reflection";
import { retrieveMemoryContext } from "../memory/retrieve";
import { extractFacts, scoreSalience } from "../memory/salience";
import { deleteFactVectors, upsertFactVector } from "../memory/vectorize";
import { fetchTelegramImageAsDataUrl } from "../telegram-api";
import { OPENCODE_GO_BASE_URL, OPENCODE_ZEN_BASE_URL, type Env } from "../types";
import {
  getBuiltinSkillByName,
  getBuiltinSkillByPath,
  isSystemSkillName,
  listBuiltinSkills,
  parseSkillDocument,
  renderLoadedSkill,
  renderSkillCatalog,
  type SkillRecord,
} from "./skills";
import { normalizeBotThreadState, pushHistory, type BotThreadState } from "./state";

type RuntimeConfig =
  | { provider: "workers"; model: string; aiBinding: Ai }
  | { provider: "opencode" | "opencode-go"; model: string; apiKey: string; baseUrl: string };

type ToolTrace = {
  name: string;
  args: Record<string, unknown>;
  ok: boolean;
  output?: unknown;
  error?: string;
  writes?: string[];
};

const GOOGLE_OAUTH_DEFAULT_PRINCIPAL = "default";
const MEMORY_FACT_TOP_K = 6;
const MEMORY_EPISODE_TOP_K = 4;
const DEFAULT_RUN_TIMEOUT_MS = 25_000;
const RUN_HEARTBEAT_INTERVAL_MS = 4_000;
const SYSTEM_PROMPT =
  "Be concise. Solve tasks with runtime-native tools and QuickJS scripts. Finish once you have enough information. Use the simplest reliable path. Keep streaming natural. Do not narrate plans. If an execute script fails, simplify it immediately instead of retrying the same shape. search is only for local runtime/package introspection, not web search.";

export class BotRuntime {
  constructor(private readonly env: Env) {}

  async status(threadId: string, state: BotThreadState): Promise<string> {
    const runtime = this.getRuntimeConfig();
    const memory = this.getMemoryConfigSafe();
    const googleLinked = Boolean(await getGoogleOAuthToken(this.env.DRECLAW_DB, GOOGLE_OAUTH_DEFAULT_PRINCIPAL));
    const controls = await getPersistedThreadControls(this.env.DRECLAW_DB, threadId);
    const persistedRunStatus = (await getPersistedRunStatus(this.env.DRECLAW_DB, threadId)) ?? state.runStatus;
    const busy = formatBusyState(persistedRunStatus);
    return [
      `model: ${runtime.model}`,
      `provider: ${runtime.provider}`,
      `memory: ${memory.enabled ? "on" : "off"}`,
      `google: ${googleLinked ? "linked" : "not linked"}`,
      `busy: ${busy}`,
      `cancel_requested: ${persistedRunStatus.cancelRequested ? "yes" : "no"}`,
      `stopped: ${persistedRunStatus.stoppedAt ? "yes" : "no"}`,
      `running_for: ${isRunStatusActive(persistedRunStatus) ? formatDurationSince(persistedRunStatus.startedAt) : "-"}`,
      `last_heartbeat: ${formatElapsedSince(persistedRunStatus.lastHeartbeatAt)}`,
      `verbose: ${(controls?.verbose ?? state.verbose) ? "on" : "off"}`,
      `history: ${state.history.length}`,
      `thread: ${threadId}`,
    ].join("\n");
  }

  help(): string {
    return [
      "Commands:",
      "/help - show commands",
      "/status - show current bot status",
      "/reset - clear conversation context",
      "/factory-reset - clear conversation, memory, runtime state, and VFS",
      "/stop - cooperatively stop the current run",
      "/verbose on|off - show tool traces",
      "/google connect - link your Google account",
      "/google status - show Google link status",
      "/google disconnect - unlink your Google account",
    ].join("\n");
  }

  reset(state: BotThreadState): BotThreadState {
    return {
      ...state,
      history: [],
      runStatus: idleRunStatus(),
    };
  }

  async factoryReset(chatId: number): Promise<BotThreadState> {
    await this.deleteMemoryData(chatId);
    await clearAllVfsEntries(this.env.DRECLAW_DB, new Date().toISOString());
    return normalizeBotThreadState(undefined);
  }

  setVerbose(state: BotThreadState, enabled: boolean): BotThreadState {
    return { ...state, verbose: enabled };
  }

  async handleGoogleCommand(text: string, chatId: number, telegramUserId: number): Promise<string> {
    const parts = text.split(/\s+/).map((item) => item.trim()).filter(Boolean);
    const action = parts[1]?.toLowerCase() ?? "";
    if (!action || action === "help") {
      return [
        "Google OAuth commands:",
        "/google connect - link your Google account",
        "/google status - show link status and scopes",
        "/google disconnect - remove saved token",
      ].join("\n");
    }

    if (action === "connect") {
      const config = getGoogleOAuthConfig(this.env);
      const state = createOAuthStateToken();
      const nowIso = new Date().toISOString();
      await createGoogleOAuthState(this.env.DRECLAW_DB, {
        state,
        chatId,
        telegramUserId,
        expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        createdAt: nowIso,
      });
      return ["Open this URL to connect Google:", buildGoogleOAuthUrl(config, state), "This link expires in 10 minutes."].join(
        "\n",
      );
    }

    if (action === "status") {
      const token = await getGoogleOAuthToken(this.env.DRECLAW_DB, GOOGLE_OAUTH_DEFAULT_PRINCIPAL);
      if (!token) return "google: not linked\nrun: /google connect";
      return ["google: linked", `scopes: ${token.scopes || "unknown"}`, `updated_at: ${token.updatedAt}`].join("\n");
    }

    if (action === "disconnect") {
      const deleted = await deleteGoogleOAuthToken(this.env.DRECLAW_DB, GOOGLE_OAUTH_DEFAULT_PRINCIPAL);
      return deleted ? "Google account disconnected." : "No linked Google account found.";
    }

    return "Unknown /google command. Use /google help";
  }

  async runConversation(params: {
    thread: Thread<BotThreadState>;
    message: Message;
    state: BotThreadState;
  }): Promise<BotThreadState> {
    const { thread, message } = params;
    let state = normalizeBotThreadState(params.state);
    const chatId = getTelegramChatId(thread.id, message.raw);
    const userText = message.text.trim();
    const imageBlocks = await loadImages(this.env, message.raw);
    const runtime = this.getRuntimeConfig();
    const toolTraces: ToolTrace[] = [];
    const tracer = new VerboseTracer(this.env.DRECLAW_DB, thread);
    const model = this.createModel(runtime);
    const promptSections = [SYSTEM_PROMPT, `Current date/time (UTC): ${new Date().toISOString()}`];
    const skillCatalog = await this.listSkills();
    promptSections.push(`Available skills:\n${renderSkillCatalog(skillCatalog)}`);
    const loadedSkills = await this.getLoadedSkills(inferImplicitSkillNames(userText));
    if (loadedSkills.length) {
      promptSections.push(`Loaded skills:\n${loadedSkills.map(renderLoadedSkill).join("\n\n")}`);
    }
    const taskGuidance = renderTaskGuidance(userText);
    if (taskGuidance) promptSections.push(`Task guidance:\n${taskGuidance}`);
    const historyContext = renderHistoryContext(state.history);
    if (historyContext) promptSections.push(`Recent context:\n${historyContext}`);
    const memoryContext = await this.renderMemoryContext(chatId, userText || "[image message]");
    if (memoryContext) promptSections.push(`Memory context:\n${memoryContext}`);
    const messages = buildAgentMessages(promptSections.join("\n\n"), userText, imageBlocks);
    state = markRunStarted(state);
    state = await this.mergeAsyncControls(thread.id, state);
    await thread.setState(stripEphemeralState(state), { replace: true });
    await setPersistedRunStatus(this.env.DRECLAW_DB, thread.id, state.runStatus);

    const agent = new ToolLoopAgent({
      model,
      stopWhen: stepCountIs(getStepLimit(userText)),
      providerOptions: this.getAgentProviderOptions(runtime),
      tools: this.createAgentTools({
        chatId,
        threadId: thread.id,
        state,
        saveState: async (next) => {
          state = next;
        },
        tracer,
        toolTraces,
      }),
    });

    const heartbeat = this.createRunHeartbeat(thread, () => state, (nextState) => {
      state = nextState;
    });

    try {
      await thread.startTyping();
    } catch {
      // noop
    }
    heartbeat.start();

    let finalText = "";
    const runTimeoutMs = getRunTimeoutMs(userText);
    try {
      await this.throwIfCancelled(thread.id);
      finalText = await withTimeout(
        (async () => {
          await this.throwIfCancelled(thread.id);
          const stream = await withTimeout(agent.stream({ messages }), runTimeoutMs, "Agent stream timed out");
          await withTimeout(thread.post(stream.textStream), runTimeoutMs, "Assistant response timed out");
          await this.throwIfCancelled(thread.id);
          const response = await withTimeout(Promise.resolve(stream.response), runTimeoutMs, "Assistant response timed out");
          const generatedText = await withTimeout(Promise.resolve(stream.text), runTimeoutMs, "Assistant text timed out");
          await this.throwIfCancelled(thread.id);
          return (typeof generatedText === "string" ? generatedText : "").trim() || extractAssistantText(response.messages as ModelMessage[]);
        })(),
        runTimeoutMs,
        "Conversation timed out",
      );
    } catch (error) {
      if (isRunCancelledError(error)) {
        heartbeat.stop();
        const persisted = await getPersistedRunStatus(this.env.DRECLAW_DB, thread.id);
        state = markRunFinished(state);
        await setPersistedRunStatus(this.env.DRECLAW_DB, thread.id, {
          ...state.runStatus,
          stoppedAt: persisted?.stoppedAt ?? new Date().toISOString(),
        });
        if (!persisted?.stoppedAt) {
          try {
            await thread.post("Stopped.");
          } catch {
            // noop
          }
        }
        state = await this.mergeAsyncControls(thread.id, state);
        return stripEphemeralState(state);
      }
      finalText = await this.recoverTimedOutRun({
        model,
        userText: userText || "[image]",
        toolTraces,
      });
      try {
        await thread.post(finalText);
      } catch {
        // noop
      }
      state = pushHistory(state, "user", userText || "[image]");
      for (const trace of toolTraces) {
        state = pushHistory(state, "tool", renderToolTranscript(trace));
      }
      state = markRunFinished(state);
      state = pushHistory(state, "assistant", finalText);
      heartbeat.stop();
      await setPersistedRunStatus(this.env.DRECLAW_DB, thread.id, state.runStatus);
      state = await this.mergeAsyncControls(thread.id, state);
      return stripEphemeralState(state);
    }

    state = pushHistory(state, "user", userText || "[image]");
    for (const trace of toolTraces) {
      state = pushHistory(state, "tool", renderToolTranscript(trace));
    }
    if (finalText) state = pushHistory(state, "assistant", finalText);
    state = markRunFinished(state);
    heartbeat.stop();
    await setPersistedRunStatus(this.env.DRECLAW_DB, thread.id, state.runStatus);
    state = await this.mergeAsyncControls(thread.id, state);

    await this.persistMemoryTurn({
      chatId,
      userText: userText || "[image]",
      assistantText: finalText,
      toolTranscripts: toolTraces.map(renderToolTranscript),
      memoryTurns: state.memoryTurns,
    });
    state.memoryTurns += 1;
    return stripEphemeralState(state);
  }

  private createRunHeartbeat(
    thread: Thread<BotThreadState>,
    getState: () => BotThreadState,
    setState: (state: BotThreadState) => void,
  ) {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      if (stopped) return;
      try {
        await this.throwIfCancelled(thread.id);
      } catch (error) {
        if (isRunCancelledError(error)) {
          stopped = true;
          if (timer) clearTimeout(timer);
          return;
        }
      }
      try {
        await thread.startTyping();
      } catch {
        // noop
      }
      const nextState = touchRunHeartbeat(getState());
      const mergedState = await this.mergeAsyncControls(thread.id, nextState);
      setState(mergedState);
      try {
        await thread.setState(stripEphemeralState(mergedState), { replace: true });
      } catch {
        // noop
      }
      try {
        await setPersistedRunStatus(this.env.DRECLAW_DB, thread.id, mergedState.runStatus);
      } catch {
        // noop
      }
      if (!stopped) timer = setTimeout(() => void tick(), RUN_HEARTBEAT_INTERVAL_MS);
    };

    return {
      start() {
        if (!timer) timer = setTimeout(() => void tick(), RUN_HEARTBEAT_INTERVAL_MS);
      },
      stop() {
        stopped = true;
        if (timer) clearTimeout(timer);
      },
    };
  }

  private async throwIfCancelled(threadId: string): Promise<void> {
    const status = await getPersistedRunStatus(this.env.DRECLAW_DB, threadId);
    if (status?.cancelRequested || status?.stoppedAt) throw new RunCancelledError();
  }

  private async mergeAsyncControls(threadId: string, state: BotThreadState): Promise<BotThreadState> {
    const controls = await getPersistedThreadControls(this.env.DRECLAW_DB, threadId);
    if (!controls) return state;
    return {
      ...state,
      verbose: controls.verbose,
    };
  }

  private createAgentTools(params: {
    chatId: number;
    threadId: string;
    state: BotThreadState;
    saveState: (state: BotThreadState) => Promise<void>;
    tracer: VerboseTracer;
    toolTraces: ToolTrace[];
  }) {
    const runTool = async <T>(name: string, args: Record<string, unknown>, execute: () => Promise<T>, writes?: string[]) => {
      await this.throwIfCancelled(params.threadId);
      await params.tracer.onToolStart(name, args);
      try {
        const result = await execute();
        await this.throwIfCancelled(params.threadId);
        const trace: ToolTrace = { name, args, ok: true, output: result, writes };
        params.toolTraces.push(trace);
        await params.tracer.onToolResult(trace);
        return result;
      } catch (error) {
        if (isRunCancelledError(error)) throw error;
        const trace: ToolTrace = {
          name,
          args,
          ok: false,
          error: redactSensitiveText(compactErrorMessage(error)),
          writes,
        };
        params.toolTraces.push(trace);
        await params.tracer.onToolResult(trace);
        return { ok: false, error: trace.error } as T;
      }
    };

    return {
      vfs: tool({
        description:
          "Manage VFS files for scripts and user skills. Use this to list, read, write, patch, and delete files when file access is needed.",
        inputSchema: z.discriminatedUnion("action", [
          z.object({ action: z.literal("list"), prefix: z.string().optional(), limit: z.number().int().min(1).max(200).optional() }),
          z.object({
            action: z.literal("read"),
            path: z.string(),
            startLine: z.number().int().min(1).optional(),
            endLine: z.number().int().min(1).optional(),
          }),
          z.object({ action: z.literal("write"), path: z.string(), content: z.string(), mode: z.enum(["create", "overwrite"]).default("overwrite") }),
          z.object({ action: z.literal("patch"), path: z.string(), search: z.string(), replace: z.string(), replaceAll: z.boolean().optional() }),
          z.object({ action: z.literal("delete"), path: z.string() }),
        ]),
        execute: async (input) => {
          const writes: string[] = [];
          return runTool(
            "vfs",
            input as Record<string, unknown>,
            async () => {
              switch (input.action) {
                case "list": {
                  const prefix = input.prefix || "/";
                  const limit = input.limit ?? 50;
                  const paths = await this.listVfsPaths(prefix, limit);
                  return { prefix: this.normalizeVfsPath(prefix), paths };
                }
                case "read": {
                  const content = await this.readVfsContent(input.path);
                  if (content === null) throw new Error(`ENOENT: ${input.path}`);
                  return { path: this.normalizeVfsPath(input.path), ...sliceVfsContent(content, input.startLine, input.endLine) };
                }
                case "write": {
                  const result = await this.writeVfsContent(input.path, input.content, input.mode === "overwrite", writes);
                  if (!result.ok) throw new Error(result.code);
                  return {
                    path: result.path,
                    mode: input.mode,
                    sizeBytes: new TextEncoder().encode(input.content).byteLength,
                    lines: countLines(input.content),
                  };
                }
                case "patch": {
                  const current = await this.readVfsContent(input.path);
                  if (current === null) throw new Error(`ENOENT: ${input.path}`);
                  const patched = patchVfsContent(current, input.search, input.replace, Boolean(input.replaceAll));
                  const result = await this.writeVfsContent(input.path, patched.content, true, writes);
                  if (!result.ok) throw new Error(result.code);
                  return {
                    path: result.path,
                    replacements: patched.replacements,
                    ...sliceVfsContent(patched.content),
                  };
                }
                case "delete": {
                  const deleted = await this.deleteVfsContent(input.path, writes);
                  if (!deleted) throw new Error(`ENOENT: ${input.path}`);
                  return { path: this.normalizeVfsPath(input.path), deleted: true };
                }
              }
            },
            writes,
          );
        },
      }),
      list_skills: tool({
        description: "List available built-in and user skills by name and description",
        inputSchema: z.object({}),
        execute: async () => runTool("list_skills", {}, async () => ({ skills: await this.listSkills() })),
      }),
      load_skill: tool({
        description: "Load full instructions for a named skill for the current turn",
        inputSchema: z.object({ name: z.string() }),
        execute: async (input) =>
          runTool("load_skill", input as Record<string, unknown>, async () => {
            const skill = await this.getSkillByName(input.name);
            if (!skill) throw new Error(`SKILL_NOT_FOUND: ${input.name}`);
            return {
              name: skill.name,
              description: skill.description,
              scope: skill.scope,
              path: skill.path,
              content: skill.content,
            };
          }),
      }),
      search: tool({
        description: "Inspect local QuickJS runtime capabilities and installed packages (not web search)",
        inputSchema: z.object({ query: z.string().optional() }),
        execute: async (input) =>
          runTool("search", input as Record<string, unknown>, async () =>
            searchCodeRuntime(
              { query: input.query },
              {
                config: this.getCodeExecutionConfig(),
                state: params.state.codeRuntime,
                saveState: async () => undefined,
              },
            ),
          ),
      }),
      execute: tool({
        description:
          "Run JavaScript in QuickJS runtime with async/await, fetch, fs.read/fs.write/fs.list/fs.remove, memory.*, built-in global `google`, and imports from vfs:/... . Return the final value explicitly. For user-facing report tasks, prefer returning a final string summary. Load relevant skills first for specialized guidance.",
        inputSchema: z.object({ code: z.string(), input: z.unknown().optional() }),
        execute: async (input) => {
          const writes: string[] = [];
          const result = await runTool(
            "execute",
            input as Record<string, unknown>,
            async () =>
              executeCode(
                { code: input.code, input: input.input },
                {
                  config: this.getCodeExecutionConfig(),
                  state: params.state.codeRuntime,
                  saveState: async (next: CodeRuntimeState) => {
                    params.state = {
                      ...params.state,
                      codeRuntime: normalizeCodeRuntimeState(next),
                    };
                  },
                  vfs: this.createVfsAdapter(writes),
                  memory: {
                    find: async (payload) => this.executeMemoryFindPayload(params.chatId, payload),
                    save: async (payload) => this.executeMemorySavePayload(params.chatId, payload),
                    remove: async (payload) => this.executeMemoryRemovePayload(params.chatId, payload),
                  },
                  googleAuth: {
                    getAccessToken: async () => this.getGoogleAccessToken(),
                    allowedServices: ["gmail", "drive", "sheets", "docs", "calendar"],
                  },
                },
              ),
            writes,
          );
          return result;
        },
      }),
    };
  }

  private async recoverTimedOutRun(params: { model: ReturnType<BotRuntime["createModel"]>; userText: string; toolTraces: ToolTrace[] }) {
    const successfulToolTraces = params.toolTraces.filter((trace) => trace.ok);
    if (successfulToolTraces.length) {
      try {
        const result = await withTimeout(
          generateText({
            model: params.model,
            system:
              "You are dréclaw. Finish the user's task using only the provided tool results. Be concise, direct, and helpful. Do not mention timeouts, internal failures, or tool orchestration. If the gathered data is incomplete, give the best useful answer you can and state the uncertainty briefly.",
            messages: [
              {
                role: "user",
                content: [
                  `User request:\n${params.userText}`,
                  `\nAvailable tool results:\n${successfulToolTraces.map(renderToolTranscript).join("\n\n")}`,
                ].join("\n"),
              },
            ],
          }),
          8_000,
          "Recovery summary timed out",
        );
        const text = result.text.trim();
        if (text) return text;
      } catch {
        // noop
      }
    }
    return "That took longer than expected. Send the same message again and I'll continue from where I left off with a simpler path.";
  }

  private async listSkills(): Promise<Array<Pick<SkillRecord, "name" | "description" | "scope">>> {
    const builtin = listBuiltinSkills().map(({ name, description, scope }) => ({ name, description, scope }));
    const userRows = await listVfsEntries(this.env.DRECLAW_DB, "/skills/user/", 200);
    const userSkills = userRows
      .filter((row) => row.path.endsWith("/SKILL.md"))
      .map((row) => {
        try {
          const parsed = parseSkillDocument(row.content);
          return { name: parsed.name, description: parsed.description, scope: "user" as const };
        } catch {
          return null;
        }
      })
      .filter((skill): skill is { name: string; description: string; scope: "user" } => Boolean(skill))
      .filter((skill) => !isSystemSkillName(skill.name));
    return [...builtin, ...userSkills].sort((a, b) => a.name.localeCompare(b.name));
  }

  private async getSkillByName(name: string): Promise<SkillRecord | null> {
    const normalized = String(name ?? "").trim();
    if (!normalized) return null;
    const builtin = getBuiltinSkillByName(normalized);
    if (builtin) return builtin;
    const row = await getVfsEntry(this.env.DRECLAW_DB, `/skills/user/${normalized}/SKILL.md`);
    if (!row) return null;
    const parsed = parseSkillDocument(row.content);
    if (parsed.name !== normalized) throw new Error(`SKILL_INVALID: name mismatch for ${normalized}`);
    return {
      name: parsed.name,
      description: parsed.description,
      scope: "user",
      path: row.path,
      content: row.content,
    };
  }

  private async getLoadedSkills(names: string[]): Promise<SkillRecord[]> {
    const loaded: SkillRecord[] = [];
    for (const name of names) {
      const skill = await this.getSkillByName(name);
      if (skill) loaded.push(skill);
    }
    return loaded;
  }

  private normalizeVfsPath(path: string): string {
    return normalizeSessionVfsPath(path);
  }

  private async readVfsContent(path: string): Promise<string | null> {
    const normalized = this.normalizeVfsPath(path);
    const builtin = getBuiltinSkillByPath(normalized);
    if (builtin) return builtin.content;
    const row = await getVfsEntry(this.env.DRECLAW_DB, normalized);
    return row ? row.content : null;
  }

  private async listVfsPaths(prefix: string, limit: number): Promise<string[]> {
    const normalized = this.normalizeVfsPath(prefix || "/");
    const rows = await listVfsEntries(this.env.DRECLAW_DB, normalized, Math.max(1, limit));
    const dynamic = listBuiltinSkills().map((item) => item.path).filter((path) => path.startsWith(normalized));
    return [...new Set([...dynamic, ...rows.map((item) => item.path)])].sort().slice(0, Math.max(1, limit));
  }

  private async writeVfsContent(path: string, content: string, overwrite: boolean, writes?: string[]) {
    const normalized = this.normalizeVfsPath(path);
    if (normalized.startsWith("/skills/system/")) return { ok: false as const, code: "VFS_READ_ONLY" as const };
    if (normalized.startsWith("/skills/user/")) this.validateUserSkillWrite(normalized, content);
    writes?.push(`write ${normalized}`);
    const config = this.getCodeExecutionConfig();
    const sizeBytes = new TextEncoder().encode(content).byteLength;
    if (sizeBytes > config.limits.vfsMaxFileBytes) return { ok: false as const, code: "VFS_LIMIT_EXCEEDED" as const };
    const result = await putVfsEntry(this.env.DRECLAW_DB, {
      path: normalized,
      content,
      sizeBytes,
      sha256: await sha256Hex(content),
      nowIso: new Date().toISOString(),
      overwrite,
    });
    return result.ok ? { ok: true as const, path: normalized } : { ok: false as const, code: result.code };
  }

  private async deleteVfsContent(path: string, writes?: string[]): Promise<boolean> {
    const normalized = this.normalizeVfsPath(path);
    if (normalized.startsWith("/skills/system/")) return false;
    writes?.push(`remove ${normalized}`);
    return deleteVfsEntry(this.env.DRECLAW_DB, normalized, new Date().toISOString());
  }

  private createVfsAdapter(writes: string[]) {
    return {
      readFile: async (path: string) => this.readVfsContent(path),
      writeFile: async (path: string, content: string, overwrite: boolean) => this.writeVfsContent(path, content, overwrite, writes),
      listFiles: async (prefix: string, limit: number) => this.listVfsPaths(prefix, limit),
      removeFile: async (path: string) => this.deleteVfsContent(path, writes),
      revision: async () => getVfsRevision(this.env.DRECLAW_DB),
    };
  }

  private validateUserSkillWrite(path: string, content: string): void {
    if (!path.startsWith("/skills/user/")) return;
    const parts = path.split("/").filter(Boolean);
    if (parts.length >= 3 && parts[2] && isSystemSkillName(parts[2])) {
      throw new Error(`SKILL_RESERVED: ${parts[2]}`);
    }
    if (!path.endsWith("/SKILL.md")) return;
    const parsed = parseSkillDocument(content);
    const dirName = parts[2] ?? "";
    if (parsed.name !== dirName) throw new Error(`SKILL_INVALID: name must match directory (${dirName})`);
    if (isSystemSkillName(parsed.name)) throw new Error(`SKILL_RESERVED: ${parsed.name}`);
  }

  private getCodeExecutionConfig() {
    return getCodeExecutionConfig(this.env as unknown as Record<string, string | undefined>);
  }

  private getRuntimeConfig(): RuntimeConfig {
    const provider = (this.env.AI_PROVIDER?.trim().toLowerCase() || "opencode") as "opencode" | "opencode-go" | "workers";
    const model = this.env.MODEL?.trim() || (provider === "workers" ? "@cf/zai-org/glm-4.7-flash" : "");
    if (!model) throw new Error("Missing MODEL");
    if (provider === "workers") {
      if (!this.env.AI) throw new Error("Missing AI binding");
      return { provider, model, aiBinding: this.env.AI };
    }
    const apiKey = this.env.OPENCODE_API_KEY?.trim();
    if (!apiKey) throw new Error("Missing OPENCODE_API_KEY");
    return {
      provider,
      model,
      apiKey,
      baseUrl: this.env.BASE_URL?.trim() || (provider === "opencode-go" ? OPENCODE_GO_BASE_URL : OPENCODE_ZEN_BASE_URL),
    };
  }

  private createModel(runtime: RuntimeConfig) {
    return runtime.provider === "workers"
      ? createWorkersModel(runtime.aiBinding, runtime.model)
      : createZenModel({ model: runtime.model, apiKey: runtime.apiKey, baseUrl: runtime.baseUrl });
  }

  private getAgentProviderOptions(runtime: RuntimeConfig): Record<string, Record<string, string>> | undefined {
    if (runtime.provider === "workers") return undefined;
    return { [runtime.provider]: { reasoningEffort: this.env.REASONING_EFFORT?.trim() || "medium" } };
  }

  private getMemoryConfigSafe() {
    try {
      return getMemoryConfig(this.env);
    } catch (error) {
      throw new Error(`Memory config error: ${compactErrorMessage(error)}`);
    }
  }

  private async executeMemoryFindPayload(chatId: number, payload: unknown): Promise<unknown> {
    const memory = this.getMemoryConfigSafe();
    if (!memory.enabled) throw new Error("Memory is disabled");
    return executeMemoryFind({ env: this.env, db: this.env.DRECLAW_DB, chatId, embeddingModel: memory.embeddingModel, payload });
  }

  private async executeMemorySavePayload(chatId: number, payload: unknown): Promise<unknown> {
    const memory = this.getMemoryConfigSafe();
    if (!memory.enabled) throw new Error("Memory is disabled");
    return executeMemorySave({ env: this.env, db: this.env.DRECLAW_DB, chatId, embeddingModel: memory.embeddingModel, payload });
  }

  private async executeMemoryRemovePayload(chatId: number, payload: unknown): Promise<unknown> {
    const memory = this.getMemoryConfigSafe();
    if (!memory.enabled) throw new Error("Memory is disabled");
    return executeMemoryRemove({ env: this.env, db: this.env.DRECLAW_DB, chatId, payload });
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
      for (const fact of retrieved.facts) lines.push(`- [${fact.kind}] ${fact.text}`);
    }
    if (retrieved.episodes.length) {
      lines.push("Recent episodes:");
      for (const episode of retrieved.episodes) lines.push(`- ${episode.role}: ${truncateForLog(episode.content, 220)}`);
    }
    const joined = lines.join("\n");
    const maxChars = memory.maxInjectTokens * 4;
    return joined.length <= maxChars ? joined : `${joined.slice(0, Math.max(0, maxChars - 1))}…`;
  }

  private async persistMemoryTurn(params: {
    chatId: number;
    userText: string;
    assistantText: string;
    toolTranscripts: string[];
    memoryTurns: number;
  }): Promise<void> {
    const memory = this.getMemoryConfigSafe();
    if (!memory.enabled) return;
    const nowIso = new Date().toISOString();
    const episodeInputs: Array<{ role: "user" | "assistant" | "tool"; content: string }> = [
      { role: "user", content: params.userText },
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

    if ((params.memoryTurns + 1) % memory.reflectionEveryTurns === 0) {
      const reflection = await runMemoryReflection({ db: this.env.DRECLAW_DB, chatId: params.chatId, limit: 24, nowIso });
      if (reflection.writtenFacts > 0) {
        const facts = await listActiveMemoryFacts(this.env.DRECLAW_DB, params.chatId, 200);
        for (const fact of facts) {
          const vector = await embedText(this.env, memory.embeddingModel, fact.text);
          await upsertFactVector(this.env, fact.id, params.chatId, vector);
        }
      }
    }

    await deleteOldMemoryEpisodes(
      this.env.DRECLAW_DB,
      params.chatId,
      new Date(Date.now() - memory.retentionDays * 24 * 60 * 60 * 1000).toISOString(),
    );
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

  private async getGoogleAccessToken(): Promise<{ accessToken: string; scope: string }> {
    const token = await getGoogleOAuthToken(this.env.DRECLAW_DB, GOOGLE_OAUTH_DEFAULT_PRINCIPAL);
    if (!token) throw new Error("Google account not linked. Run /google connect");
    const refreshToken = await decryptSecret(
      { ciphertext: token.refreshTokenCiphertext, nonce: token.nonce },
      decodeEncryptionKey(String(this.env.GOOGLE_OAUTH_ENCRYPTION_KEY ?? "")),
    );
    const refreshed = await refreshGoogleAccessToken(getGoogleOAuthConfig(this.env), refreshToken, this.getCodeExecutionConfig().limits.netRequestTimeoutMs);
    return { accessToken: refreshed.accessToken, scope: refreshed.scope };
  }

}

class VerboseTracer {
  constructor(private readonly db: D1Database, private readonly thread: Thread<BotThreadState>) {}

  private async isEnabled(): Promise<boolean> {
    const controls = await getPersistedThreadControls(this.db, this.thread.id);
    return Boolean(controls?.verbose);
  }

  async onToolStart(name: string, args: Record<string, unknown>): Promise<void> {
    if (!(await this.isEnabled())) return;
    await this.thread.post({ markdown: renderTraceStart(name, args) });
  }

  async onToolResult(trace: ToolTrace): Promise<void> {
    if (!(await this.isEnabled())) return;
    await this.thread.post({ markdown: renderTraceResult(trace) });
  }
}

class RunCancelledError extends Error {
  constructor() {
    super("Run cancelled");
  }
}

function isRunCancelledError(error: unknown): error is RunCancelledError {
  return error instanceof RunCancelledError;
}

function buildAgentMessages(systemPrompt: string, userText: string, imageBlocks: string[]): ModelMessage[] {
  const parts: Array<{ type: "text"; text: string } | { type: "image"; image: string }> = [];
  parts.push({ type: "text", text: userText || "[image message]" });
  for (const image of imageBlocks) parts.push({ type: "image", image });
  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: imageBlocks.length ? parts : userText || "[image message]" },
  ];
}

async function loadImages(env: Env, rawMessage: unknown): Promise<string[]> {
  const photo = (rawMessage as { photo?: Array<{ file_id?: string; file_size?: number }> })?.photo;
  if (!Array.isArray(photo) || !photo.length) return [];
  const best = [...photo].sort((a, b) => Number(b.file_size ?? 0) - Number(a.file_size ?? 0))[0];
  if (!best?.file_id) return [];
  const image = await fetchTelegramImageAsDataUrl(env.TELEGRAM_BOT_TOKEN, best.file_id);
  return image ? [image] : [];
}

function renderHistoryContext(history: BotThreadState["history"]): string {
  if (!history.length) return "";
  return history.map((entry) => `${entry.role}: ${entry.content}`).join("\n");
}

function sliceVfsContent(content: string, startLine?: number, endLine?: number) {
  const lines = content.split("\n");
  const start = Math.max(1, Math.min(lines.length || 1, startLine ?? 1));
  const end = Math.max(start, Math.min(lines.length || start, endLine ?? lines.length));
  return {
    content: lines.slice(start - 1, end).join("\n"),
    totalLines: lines.length,
    startLine: start,
    endLine: end,
  };
}

function patchVfsContent(content: string, search: string, replace: string, replaceAll: boolean) {
  if (!search) throw new Error("PATCH_INVALID: search must be non-empty");
  const occurrences = countOccurrences(content, search);
  if (occurrences === 0) throw new Error("PATCH_NOT_FOUND");
  if (!replaceAll && occurrences > 1) throw new Error("PATCH_AMBIGUOUS");
  return {
    content: replaceAll ? content.split(search).join(replace) : content.replace(search, replace),
    replacements: replaceAll ? occurrences : 1,
  };
}

function countOccurrences(content: string, search: string): number {
  let count = 0;
  let index = 0;
  while (true) {
    index = content.indexOf(search, index);
    if (index === -1) return count;
    count += 1;
    index += Math.max(1, search.length);
  }
}

function countLines(content: string): number {
  return content ? content.split("\n").length : 0;
}

function stripEphemeralState(state: BotThreadState): BotThreadState {
  return {
    ...state,
    codeRuntime: normalizeCodeRuntimeState(undefined),
    loadedSkills: [],
  };
}

function idleRunStatus() {
  return {
    running: false,
    startedAt: null,
    lastHeartbeatAt: null,
    cancelRequested: false,
    cancelRequestedAt: null,
    stoppedAt: null,
  };
}

function markRunStarted(state: BotThreadState): BotThreadState {
  const nowIso = new Date().toISOString();
  return {
    ...state,
    runStatus: {
      running: true,
      startedAt: nowIso,
      lastHeartbeatAt: nowIso,
      cancelRequested: false,
      cancelRequestedAt: null,
      stoppedAt: null,
    },
  };
}

function touchRunHeartbeat(state: BotThreadState): BotThreadState {
  if (!state.runStatus.running) return state;
  return {
    ...state,
    runStatus: {
      ...state.runStatus,
      lastHeartbeatAt: new Date().toISOString(),
    },
  };
}

function markRunFinished(state: BotThreadState): BotThreadState {
  return {
    ...state,
    runStatus: idleRunStatus(),
  };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeoutPromise = new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    });
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function getStepLimit(userText: string): number {
  const text = String(userText ?? "").toLowerCase();
  if (/gmail|email|inbox/.test(text)) {
    return 10;
  }
  if (/calendar|drive|docs|sheets|google|script|skill|workflow|library|merge|update/.test(text)) {
    return 12;
  }
  if (/compare|research|investigate|debug/.test(text)) {
    return 14;
  }
  return 8;
}

function getRunTimeoutMs(userText: string): number {
  const text = String(userText ?? "").toLowerCase();
  if (/gmail|email|inbox|calendar|drive|docs|sheets|google/.test(text)) {
    return 22_000;
  }
  return DEFAULT_RUN_TIMEOUT_MS;
}

function formatElapsedSince(iso: string | null): string {
  if (!iso) return "-";
  const deltaMs = Date.now() - Date.parse(iso);
  if (!Number.isFinite(deltaMs) || deltaMs < 0) return "-";
  const seconds = Math.floor(deltaMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  const remSeconds = seconds % 60;
  return remSeconds ? `${minutes}m ${remSeconds}s ago` : `${minutes}m ago`;
}

function formatBusyState(runStatus: BotThreadState["runStatus"]): string {
  if (isRunStatusActive(runStatus)) return "yes";
  if (runStatus.running) return "stale";
  return "no";
}

function isRunStatusActive(runStatus: BotThreadState["runStatus"]): boolean {
  if (!runStatus.running) return false;
  if (!runStatus.lastHeartbeatAt) return false;
  const deltaMs = Date.now() - Date.parse(runStatus.lastHeartbeatAt);
  return Number.isFinite(deltaMs) && deltaMs >= 0 && deltaMs <= 15_000;
}

function formatDurationSince(iso: string | null): string {
  if (!iso) return "-";
  const deltaMs = Date.now() - Date.parse(iso);
  if (!Number.isFinite(deltaMs) || deltaMs < 0) return "-";
  const seconds = Math.floor(deltaMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remSeconds = seconds % 60;
  return remSeconds ? `${minutes}m ${remSeconds}s` : `${minutes}m`;
}

function inferImplicitSkillNames(userText: string): string[] {
  const text = String(userText ?? "").toLowerCase();
  const names = new Set<string>();
  if (/gmail|email|inbox|calendar|drive|docs|sheets|google/.test(text)) {
    names.add("google");
    names.add("quickjs");
  }
  if (/script|helper|vfs|module|import/.test(text)) {
    names.add("vfs");
    names.add("quickjs");
  }
  if (/memory|remember|label/.test(text)) names.add("memory");
  if (/skill|workflow/.test(text)) names.add("skill-authoring");
  return [...names];
}

function renderTaskGuidance(userText: string): string {
  const text = String(userText ?? "").toLowerCase();
  const lines: string[] = [];
  if (/gmail|email|inbox/.test(text)) {
    lines.push("- For Gmail summaries, use at most one google.execute call per execute run.");
    lines.push("- Good pattern: one execute run to list ids, one execute run per message detail, one final execute run to format a string summary.");
    lines.push("- For detail fetch runs, do not use return JSON.stringify({ ... }). Assign fields to const vars and return a plain string.");
    lines.push("- If one execute script fails, rewrite it to the simplest plain-string form on the next try.");
  }
  if (/calendar/.test(text)) {
    lines.push("- For Calendar tasks, prefer one focused execute run per API step and return a final string summary.");
  }
  return lines.join("\n");
}

function renderToolTranscript(trace: ToolTrace): string {
  return [
    `tool=${trace.name}`,
    `ok=${trace.ok}`,
    `args=${redactSensitiveText(serializeUnknown(trace.args))}`,
    trace.writes?.length ? `writes=${trace.writes.join(", ")}` : "",
    trace.ok
      ? `output=${redactSensitiveText(truncateForLog(serializeUnknown(trace.output), 1200))}`
      : `error=${trace.error || "tool failed"}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function renderTraceStart(name: string, args: Record<string, unknown>): string {
  if (name === "load_skill") return `Tool: ${name}\nname: ${String(args.name ?? "")}`;
  if (name === "list_skills") return `Tool: ${name}`;
  if (name === "vfs") {
    const action = String(args.action ?? "");
    const path = typeof args.path === "string" ? `\npath: ${args.path}` : "";
    const prefix = typeof args.prefix === "string" ? `\nprefix: ${args.prefix}` : "";
    return `Tool: ${name}\naction: ${action}${path}${prefix}`;
  }
  if (name === "execute") {
    const code = typeof args.code === "string" ? args.code : "";
    const input = Object.prototype.hasOwnProperty.call(args, "input") ? `\ninput: ${redactSensitiveText(serializeUnknown(args.input))}` : "";
    return `Tool: ${name}\n\n\`\`\`js\n${code}\n\`\`\`${input}`;
  }
  return `Tool: ${name}\nargs: ${redactSensitiveText(serializeUnknown(args))}`;
}

function renderTraceResult(trace: ToolTrace): string {
  const executeOk =
    trace.name === "execute" && trace.output && typeof trace.output === "object" && "ok" in (trace.output as Record<string, unknown>)
      ? Boolean((trace.output as Record<string, unknown>).ok)
      : trace.ok;
  const lines = [`Tool result: ${trace.name} ${trace.ok ? "ok" : "failed"}`];
  lines[0] = `Tool result: ${trace.name} ${executeOk ? "ok" : "failed"}`;
  if (trace.ok && trace.name === "load_skill" && trace.output && typeof trace.output === "object") {
    const output = trace.output as Record<string, unknown>;
    lines.push(`loaded: ${String(output.name ?? "")}`);
    lines.push(`scope: ${String(output.scope ?? "")}`);
    lines.push(`path: ${String(output.path ?? "")}`);
    return lines.join("\n");
  }
  if (trace.ok && trace.name === "list_skills" && trace.output && typeof trace.output === "object") {
    const skills = Array.isArray((trace.output as { skills?: unknown[] }).skills) ? ((trace.output as { skills: unknown[] }).skills as unknown[]) : [];
    lines.push(`skills: ${skills.length}`);
    lines.push(`result: ${redactSensitiveText(truncateForLog(serializeUnknown(trace.output), 600))}`);
    return lines.join("\n");
  }
  if (trace.ok && trace.name === "vfs") {
    lines.push(`result: ${redactSensitiveText(truncateForLog(serializeUnknown(trace.output), 1200))}`);
    return lines.join("\n");
  }
  if (trace.writes?.length) lines.push(`writes: ${trace.writes.join(", ")}`);
  if (trace.ok) lines.push(`result: ${redactSensitiveText(truncateForLog(serializeUnknown(trace.output), 1200))}`);
  else lines.push(`error: ${trace.error || "tool failed"}`);
  return lines.join("\n");
}

function extractAssistantText(messages: ModelMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index] as { role?: unknown; content?: unknown };
    if (message.role !== "assistant") continue;
    if (typeof message.content === "string") return message.content.trim();
  }
  return "";
}

function getTelegramChatId(threadId: string, rawMessage: unknown): number {
  const raw = (rawMessage as { chat?: { id?: number } })?.chat?.id;
  if (typeof raw === "number") return raw;
  const maybe = Number(threadId.split(":").at(-1));
  if (Number.isFinite(maybe)) return maybe;
  throw new Error("Unable to resolve Telegram chat id");
}

function normalizeSessionVfsPath(rawPath: string): string {
  const input = String(rawPath ?? "").trim();
  if (!input) throw new Error("VFS_INVALID_PATH: path is required");
  const path = input.startsWith("vfs:/") ? input.slice(4) : input;
  if (!path.startsWith("/")) throw new Error("VFS_INVALID_PATH: path must be absolute");
  const normalized: string[] = [];
  for (const part of path.split("/")) {
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
  return compact.length <= max ? compact : `${compact.slice(0, max - 1)}…`;
}

function compactErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error ?? "unknown error");
  }
}

function serializeUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value ?? "");
  }
}

function redactSensitiveText(input: string): string {
  let redacted = String(input ?? "");
  for (const pattern of [
    /(api[_-]?key\s*[:=]\s*)([^\s,;]+)/gi,
    /(token\s*[:=]\s*)([^\s,;]+)/gi,
    /(secret\s*[:=]\s*)([^\s,;]+)/gi,
    /(authorization\s*[:=]\s*)([^\s,;]+)/gi,
    /(bearer\s+)([^\s,;]+)/gi,
  ]) {
    redacted = redacted.replace(pattern, (_match, prefix: string) => `${prefix}[REDACTED]`);
  }
  return redacted;
}
