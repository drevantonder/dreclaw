import { ToolLoopAgent, generateText, stepCountIs, tool, type ModelMessage } from "ai";
import type { Thread, Message } from "chat";
import { z } from "zod";
import { getPersistedThreadControls } from "./repo";
import {
  executeCode,
  getCodeExecutionConfig,
  normalizeCodeRuntimeState,
  type ExecuteHostBinding,
} from "../tools/code-exec";
import { createAgendaService, type AssistantAgendaItem } from "../agenda";
import { executeBash } from "../tools/bash";
import { createMemoryRuntime } from "../memory";
import { renderLoadedSkill, renderSkillCatalog, type SkillRecord } from "../skills";
import { clearAllVfsEntries } from "../vfs/repo";
import { createWorkspace } from "../vfs";
import type { Env } from "../../cloudflare/env";
import { createGooglePlugin } from "../../plugins/google";
import { OPENCODE_GO_BASE_URL, OPENCODE_ZEN_BASE_URL } from "./llm/constants";
import { createZenModel } from "./llm/zen";
import { createWorkersModel } from "./llm/workers";
import { RunCancelledError, createRunCoordinator, idleRunStatus } from "./run";
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

type ToolTracer = {
  onToolStart(name: string, args: Record<string, unknown>): Promise<void>;
  onToolResult(trace: ToolTrace): Promise<void>;
};

const MEMORY_FACT_TOP_K = 6;
const MEMORY_EPISODE_TOP_K = 4;
const DEFAULT_RUN_TIMEOUT_MS = 25_000;
const PROACTIVE_NO_MESSAGE = "NO_MESSAGE";
const scheduleSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("once"),
    atLocal: z.string(),
  }),
  z.object({
    type: z.literal("recurring"),
    cadence: z.enum(["daily", "weekdays", "weekly", "monthly"]),
    atLocalTime: z.string(),
    daysOfWeek: z.array(z.number().int().min(0).max(6)).optional(),
    dayOfMonth: z.number().int().min(1).max(31).optional(),
    interval: z.number().int().min(1).max(365).optional(),
  }),
]);
const SYSTEM_PROMPT =
  "Be concise. Solve tasks with runtime-native tools and sandboxed execute scripts. Finish once you have enough information. Use the simplest reliable path. Keep streaming natural. Do not narrate plans. Before the final answer, avoid filler progress updates like 'let me check' or 'now I will'. Prefer silent tool calls unless a brief user-facing checkpoint is genuinely helpful. If an execute script fails, simplify it immediately instead of retrying the same shape. Use agenda tools to track follow-ups, recurring responsibilities, and commitments you should wake for later.";

export class BotRuntime {
  private readonly runs: ReturnType<typeof createRunCoordinator>;

  constructor(
    private readonly env: Env,
    private readonly executionContext?: ExecutionContext & {
      exports?: Record<string, (options?: { props?: unknown }) => ExecuteHostBinding>;
    },
  ) {
    this.runs = createRunCoordinator(env);
  }

  async status(threadId: string, state: BotThreadState): Promise<string> {
    const runtime = this.getRuntimeConfig();
    const memory = this.getMemoryConfigSafe();
    const googleLinked = await this.google().isLinked();
    const controls = await getPersistedThreadControls(this.env.DRECLAW_DB, threadId);
    const run = await this.runs.getStatus(threadId, state);
    return [
      `model: ${runtime.model}`,
      `provider: ${runtime.provider}`,
      `memory: ${memory.enabled ? "on" : "off"}`,
      `google: ${googleLinked ? "linked" : "not linked"}`,
      `busy: ${run.busy}`,
      `cancel_requested: ${run.runStatus.cancelRequested ? "yes" : "no"}`,
      `stopped: ${run.runStatus.stoppedAt ? "yes" : "no"}`,
      `workflow_id: ${run.workflowInstanceId ?? run.runStatus.workflowInstanceId ?? "-"}`,
      `running_for: ${run.runningFor}`,
      `last_heartbeat: ${run.lastHeartbeat}`,
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
      "/factory-reset - clear conversation, memory, and VFS",
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
    await this.getMemoryRuntime().factoryReset({ chatId });
    await clearAllVfsEntries(this.env.DRECLAW_DB, new Date().toISOString());
    return normalizeBotThreadState(undefined);
  }

  setVerbose(state: BotThreadState, enabled: boolean): BotThreadState {
    return { ...state, verbose: enabled };
  }

  async runConversation(params: {
    thread: Thread<BotThreadState>;
    message: Message;
    chatId: number;
    state: BotThreadState;
    runTimeoutMs?: number;
    imageBlocks?: string[];
  }): Promise<BotThreadState> {
    const { thread, message } = params;
    let state = normalizeBotThreadState(params.state);
    const { chatId } = params;
    const userText = message.text.trim();
    const imageBlocks = params.imageBlocks ?? [];
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
    const memoryContext = await this.getMemoryRuntime().renderContext({
      chatId,
      query: userText || "[image message]",
      factTopK: MEMORY_FACT_TOP_K,
      episodeTopK: MEMORY_EPISODE_TOP_K,
    });
    if (memoryContext) promptSections.push(`Memory context:\n${memoryContext}`);
    const messages = buildAgentMessages(promptSections.join("\n\n"), userText, imageBlocks);
    state = this.runs.startRun(state);
    state = await this.runs.recoverState(thread.id, state);
    await thread.setState(stripEphemeralState(state), { replace: true });
    await this.runs.persistRunState(thread.id, state);

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

    const heartbeat = this.runs.createHeartbeat({
      thread,
      getState: () => state,
      setState: (nextState) => {
        state = nextState;
      },
      serializeState: stripEphemeralState,
    });

    try {
      await thread.startTyping();
    } catch {
      // noop
    }
    heartbeat.start();

    let finalText = "";
    const runTimeoutMs = params.runTimeoutMs ?? getRunTimeoutMs(userText);
    try {
      await this.runs.throwIfCancelled(thread.id);
      finalText = await withTimeout(
        (async () => {
          await this.runs.throwIfCancelled(thread.id);
          const stream = await withTimeout(
            agent.stream({ messages }),
            runTimeoutMs,
            "Agent stream timed out",
          );
          await withTimeout(
            thread.post(stream.textStream),
            runTimeoutMs,
            "Assistant response timed out",
          );
          await this.runs.throwIfCancelled(thread.id);
          const response = await withTimeout(
            Promise.resolve(stream.response),
            runTimeoutMs,
            "Assistant response timed out",
          );
          const generatedText = await withTimeout(
            Promise.resolve(stream.text),
            runTimeoutMs,
            "Assistant text timed out",
          );
          await this.runs.throwIfCancelled(thread.id);
          return (
            (typeof generatedText === "string" ? generatedText : "").trim() ||
            extractAssistantText(response.messages as ModelMessage[])
          );
        })(),
        runTimeoutMs,
        "Conversation timed out",
      );
    } catch (error) {
      if (isRunCancelledError(error)) {
        heartbeat.stop();
        const persisted = (await this.runs.getStatus(thread.id, state)).runStatus;
        state = this.runs.finishRun(state);
        await this.runs.persistRunState(thread.id, {
          ...state,
          runStatus: {
            ...state.runStatus,
            stoppedAt: persisted.stoppedAt ?? new Date().toISOString(),
          },
        });
        if (!persisted.stoppedAt) {
          try {
            await thread.post("Stopped.");
          } catch {
            // noop
          }
        }
        state = await this.runs.recoverState(thread.id, state);
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
      state = this.runs.finishRun(state);
      state = pushHistory(state, "assistant", finalText);
      heartbeat.stop();
      await this.runs.persistRunState(thread.id, state);
      state = await this.runs.recoverState(thread.id, state);
      return stripEphemeralState(state);
    }

    state = pushHistory(state, "user", userText || "[image]");
    for (const trace of toolTraces) {
      state = pushHistory(state, "tool", renderToolTranscript(trace));
    }
    if (finalText) state = pushHistory(state, "assistant", finalText);
    state = this.runs.finishRun(state);
    heartbeat.stop();
    await this.runs.persistRunState(thread.id, state);
    state = await this.runs.recoverState(thread.id, state);

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

  async runConversationAgentStep(params: {
    thread: Thread<BotThreadState>;
    message: Message;
    chatId: number;
    state: BotThreadState;
    runTimeoutMs?: number;
    baseMessages?: ModelMessage[];
    isFirstStep?: boolean;
    imageBlocks?: string[];
  }): Promise<{ state: BotThreadState; nextMessages: ModelMessage[]; shouldContinue: boolean }> {
    const { thread, message } = params;
    let state = normalizeBotThreadState(params.state);
    const { chatId } = params;
    const userText = message.text.trim();
    const imageBlocks = params.imageBlocks ?? [];
    const runtime = this.getRuntimeConfig();
    const toolTraces: ToolTrace[] = [];
    const tracer = new VerboseTracer(this.env.DRECLAW_DB, thread);
    const model = this.createModel(runtime);
    const inputMessages = isModelMessageArray(params.baseMessages)
      ? params.baseMessages
      : await this.buildConversationMessages({ chatId, state, userText, imageBlocks });
    const runTimeoutMs = params.runTimeoutMs ?? getRunTimeoutMs(userText);
    let stepHadToolCalls = false;
    let stepText = "";

    const agent = new ToolLoopAgent({
      model,
      stopWhen: stepCountIs(1),
      providerOptions: this.getAgentProviderOptions(runtime),
      tools: this.createAgentTools({
        chatId,
        threadId: thread.id,
        state,
        saveState: async (next) => {
          state = next;
          await thread.setState(stripEphemeralState(state), { replace: true });
        },
        tracer,
        toolTraces,
      }),
    });

    const heartbeat = this.runs.createHeartbeat({
      thread,
      getState: () => state,
      setState: (nextState) => {
        state = nextState;
      },
      serializeState: stripEphemeralState,
    });

    try {
      await thread.startTyping();
    } catch {
      // noop
    }
    heartbeat.start();

    try {
      await this.runs.throwIfCancelled(thread.id);
      const stream = await withTimeout(
        agent.stream({
          messages: inputMessages,
          onStepFinish(step) {
            stepHadToolCalls = (step.toolCalls?.length ?? 0) > 0;
            stepText = typeof step.text === "string" ? step.text : "";
          },
        }),
        runTimeoutMs,
        "Agent step timed out",
      );
      const response = await withTimeout(
        Promise.resolve(stream.response),
        runTimeoutMs,
        "Assistant response timed out",
      );
      const text = await withTimeout(
        Promise.resolve(stream.text),
        runTimeoutMs,
        "Assistant text timed out",
      );
      await this.runs.throwIfCancelled(thread.id);
      const responseMessages = isModelMessageArray(response.messages) ? response.messages : [];
      const nextMessages = mergeContinuationMessages(inputMessages, responseMessages);

      heartbeat.stop();
      if (params.isFirstStep) state = pushHistory(state, "user", userText || "[image]");
      for (const trace of toolTraces) {
        state = pushHistory(state, "tool", renderToolTranscript(trace));
      }

      const assistantText =
        [text, stepText].find((value) => typeof value === "string" && value.trim())?.trim() ?? "";
      if (assistantText && !stepHadToolCalls) {
        try {
          await thread.post(assistantText);
        } catch {
          // noop
        }
        state = pushHistory(state, "assistant", assistantText);
      }
      if (!stepHadToolCalls) {
        state = this.runs.finishRun(state);
        await this.runs.persistRunState(thread.id, state);
      }
      return { state: stripEphemeralState(state), nextMessages, shouldContinue: stepHadToolCalls };
    } catch (error) {
      heartbeat.stop();
      if (isRunCancelledError(error)) {
        state = this.runs.finishRun(state);
        await this.runs.persistRunState(thread.id, state);
        return {
          state: stripEphemeralState(state),
          nextMessages: inputMessages,
          shouldContinue: false,
        };
      }
      throw error;
    }
  }

  async runProactiveWake(params: {
    threadId: string;
    chatId: number;
    state: BotThreadState;
    item: AssistantAgendaItem;
    recentWakeSummaries: string[];
  }): Promise<{ state: BotThreadState; messageText: string | null; summary: string }> {
    let state = normalizeBotThreadState(params.state);
    const runtime = this.getRuntimeConfig();
    const toolTraces: ToolTrace[] = [];
    const model = this.createModel(runtime);
    const wakePacket = renderWakePacket(params.item, params.recentWakeSummaries);
    const promptSections = [
      SYSTEM_PROMPT,
      [
        "You are waking proactively on your own agenda.",
        "You woke because an internal agenda item became due.",
        `If no user-facing message is needed after any background work, reply exactly with ${PROACTIVE_NO_MESSAGE}.`,
        "If a message is useful, make it concise and action-oriented.",
        "Keep your agenda tidy by updating, rescheduling, snoozing, or completing items.",
      ].join(" "),
      `Current date/time (UTC): ${new Date().toISOString()}`,
    ];
    const skillCatalog = await this.listSkills();
    promptSections.push(`Available skills:\n${renderSkillCatalog(skillCatalog)}`);
    const loadedSkills = await this.getLoadedSkills(inferImplicitSkillNames(wakePacket));
    if (loadedSkills.length) {
      promptSections.push(`Loaded skills:\n${loadedSkills.map(renderLoadedSkill).join("\n\n")}`);
    }
    const historyContext = renderHistoryContext(state.history);
    if (historyContext) promptSections.push(`Recent context:\n${historyContext}`);
    const memoryContext = await this.getMemoryRuntime().renderContext({
      chatId: params.chatId,
      query: `${params.item.title}\n${params.item.notes}`.trim() || "[agenda wake]",
      factTopK: MEMORY_FACT_TOP_K,
      episodeTopK: MEMORY_EPISODE_TOP_K,
    });
    if (memoryContext) promptSections.push(`Memory context:\n${memoryContext}`);

    const agent = new ToolLoopAgent({
      model,
      stopWhen: stepCountIs(8),
      providerOptions: this.getAgentProviderOptions(runtime),
      tools: this.createAgentTools({
        chatId: params.chatId,
        threadId: params.threadId,
        state,
        saveState: async (next) => {
          state = next;
        },
        tracer: new NoopTracer(),
        toolTraces,
      }),
    });

    let finalText = "";
    try {
      const stream = await withTimeout(
        agent.stream({
          messages: buildAgentMessages(promptSections.join("\n\n"), wakePacket, []),
        }),
        DEFAULT_RUN_TIMEOUT_MS,
        "Proactive wake timed out",
      );
      const response = await withTimeout(
        Promise.resolve(stream.response),
        DEFAULT_RUN_TIMEOUT_MS,
        "Proactive response timed out",
      );
      const text = await withTimeout(
        Promise.resolve(stream.text),
        DEFAULT_RUN_TIMEOUT_MS,
        "Proactive text timed out",
      );
      finalText =
        (typeof text === "string" ? text : "").trim() ||
        extractAssistantText((response.messages as ModelMessage[]) ?? []);
    } catch {
      finalText = await this.recoverTimedOutRun({ model, userText: wakePacket, toolTraces });
    }

    for (const trace of toolTraces) state = pushHistory(state, "tool", renderToolTranscript(trace));

    const messageText = normalizeProactiveMessage(finalText);
    if (messageText) state = pushHistory(state, "assistant", messageText);
    return {
      state: stripEphemeralState(state),
      messageText,
      summary: summarizeProactiveWake(params.item, messageText, toolTraces),
    };
  }

  private async buildConversationMessages(params: {
    chatId: number;
    state: BotThreadState;
    userText: string;
    imageBlocks: string[];
  }) {
    const promptSections = [SYSTEM_PROMPT, `Current date/time (UTC): ${new Date().toISOString()}`];
    const skillCatalog = await this.listSkills();
    promptSections.push(`Available skills:\n${renderSkillCatalog(skillCatalog)}`);
    const loadedSkills = await this.getLoadedSkills(inferImplicitSkillNames(params.userText));
    if (loadedSkills.length) {
      promptSections.push(`Loaded skills:\n${loadedSkills.map(renderLoadedSkill).join("\n\n")}`);
    }
    const taskGuidance = renderTaskGuidance(params.userText);
    if (taskGuidance) promptSections.push(`Task guidance:\n${taskGuidance}`);
    const historyContext = renderHistoryContext(params.state.history);
    if (historyContext) promptSections.push(`Recent context:\n${historyContext}`);
    const memoryContext = await this.getMemoryRuntime().renderContext({
      chatId: params.chatId,
      query: params.userText || "[image message]",
      factTopK: MEMORY_FACT_TOP_K,
      episodeTopK: MEMORY_EPISODE_TOP_K,
    });
    if (memoryContext) promptSections.push(`Memory context:\n${memoryContext}`);
    return buildAgentMessages(promptSections.join("\n\n"), params.userText, params.imageBlocks);
  }

  private createAgentTools(params: {
    chatId: number;
    threadId: string;
    state: BotThreadState;
    saveState: (state: BotThreadState) => Promise<void>;
    tracer: ToolTracer;
    toolTraces: ToolTrace[];
  }) {
    const agenda = this.getAgendaService(params.chatId);
    const runTool = async <T>(
      name: string,
      args: Record<string, unknown>,
      execute: () => Promise<T>,
      writes?: string[],
    ) => {
      await this.runs.throwIfCancelled(params.threadId);
      await params.tracer.onToolStart(name, args);
      try {
        const result = await execute();
        await this.runs.throwIfCancelled(params.threadId);
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
          z.object({
            action: z.literal("list"),
            prefix: z.string().optional(),
            limit: z.number().int().min(1).max(200).optional(),
          }),
          z.object({
            action: z.literal("read"),
            path: z.string(),
            startLine: z.number().int().min(1).optional(),
            endLine: z.number().int().min(1).optional(),
          }),
          z.object({
            action: z.literal("write"),
            path: z.string(),
            content: z.string(),
            mode: z.enum(["create", "overwrite"]).default("overwrite"),
          }),
          z.object({
            action: z.literal("patch"),
            path: z.string(),
            search: z.string(),
            replace: z.string(),
            replaceAll: z.boolean().optional(),
          }),
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
                  const workspace = this.getWorkspace();
                  const paths = await workspace.listFiles(prefix, limit);
                  return { prefix: workspace.normalizePath(prefix), paths };
                }
                case "read": {
                  const content = await this.getWorkspace().readFile(input.path);
                  if (content === null) throw new Error(`ENOENT: ${input.path}`);
                  return {
                    path: this.getWorkspace().normalizePath(input.path),
                    ...sliceVfsContent(content, input.startLine, input.endLine),
                  };
                }
                case "write": {
                  const result = await this.writeWorkspaceFile(
                    input.path,
                    input.content,
                    input.mode === "overwrite",
                    writes,
                  );
                  if (!result.ok) throw new Error(result.code);
                  return {
                    path: result.path,
                    mode: input.mode,
                    sizeBytes: new TextEncoder().encode(input.content).byteLength,
                    lines: countLines(input.content),
                  };
                }
                case "patch": {
                  const current = await this.getWorkspace().readFile(input.path);
                  if (current === null) throw new Error(`ENOENT: ${input.path}`);
                  const patched = patchVfsContent(
                    current,
                    input.search,
                    input.replace,
                    Boolean(input.replaceAll),
                  );
                  const result = await this.writeWorkspaceFile(
                    input.path,
                    patched.content,
                    true,
                    writes,
                  );
                  if (!result.ok) throw new Error(result.code);
                  return {
                    path: result.path,
                    replacements: patched.replacements,
                    ...sliceVfsContent(patched.content),
                  };
                }
                case "delete": {
                  const deleted = await this.deleteWorkspaceFile(input.path, writes);
                  if (!deleted) throw new Error(`ENOENT: ${input.path}`);
                  return { path: this.getWorkspace().normalizePath(input.path), deleted: true };
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
        execute: async () =>
          runTool("list_skills", {}, async () => ({
            skills: await this.getWorkspace().listSkills(),
          })),
      }),
      load_skill: tool({
        description: "Load full instructions for a named skill for the current turn",
        inputSchema: z.object({ name: z.string() }),
        execute: async (input) =>
          runTool("load_skill", input as Record<string, unknown>, async () => {
            const skill = await this.getWorkspace().loadSkill(input.name);
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
      agenda_query: tool({
        description:
          "Query the assistant's internal agenda of follow-ups, recurring responsibilities, and reminders.",
        inputSchema: z.object({
          filter: z
            .object({
              status: z.enum(["open", "done", "cancelled"]).optional(),
              kind: z.string().optional(),
              text: z.string().optional(),
              dueBefore: z.string().optional(),
              sourceChatId: z.number().int().optional(),
            })
            .optional(),
          limit: z.number().int().min(1).max(50).optional(),
        }),
        execute: async (input) =>
          runTool("agenda_query", input as Record<string, unknown>, async () => ({
            items: await agenda.query(input.filter, input.limit ?? 20),
          })),
      }),
      agenda_update: tool({
        description:
          "Create or update the assistant's internal agenda items. Use this to track follow-ups, reschedule wakes, snooze items, or mark them complete.",
        inputSchema: z.discriminatedUnion("action", [
          z.object({
            action: z.literal("create"),
            item: z.object({
              kind: z.string().optional(),
              title: z.string(),
              notes: z.string().optional(),
              priority: z.number().int().min(1).max(5).optional(),
              nextWakeAt: z.string().nullable().optional(),
              schedule: scheduleSchema.optional(),
              sourceChatId: z.number().int().nullable().optional(),
            }),
          }),
          z.object({
            action: z.literal("patch"),
            itemId: z.string(),
            patch: z.object({
              kind: z.string().optional(),
              title: z.string().optional(),
              notes: z.string().optional(),
              priority: z.number().int().min(1).max(5).optional(),
              nextWakeAt: z.string().nullable().optional(),
              schedule: scheduleSchema.nullable().optional(),
              sourceChatId: z.number().int().nullable().optional(),
              status: z.enum(["open", "done", "cancelled"]).optional(),
            }),
          }),
          z.object({ action: z.literal("complete"), itemId: z.string() }),
          z.object({ action: z.literal("cancel"), itemId: z.string() }),
          z.object({ action: z.literal("snooze"), itemId: z.string(), nextWakeAt: z.string() }),
          z.object({
            action: z.literal("reschedule"),
            itemId: z.string(),
            nextWakeAt: z.string(),
          }),
          z.object({ action: z.literal("append_note"), itemId: z.string(), note: z.string() }),
        ]),
        execute: async (input) =>
          runTool("agenda_update", input as Record<string, unknown>, async () =>
            agenda.update(input, { sourceChatId: params.chatId }),
          ),
      }),
      bash: tool({
        description:
          "Run bash commands in a sandboxed shell with core Unix tools, VFS-backed files, and full network access via curl. Use this for shell/text/file/network tasks. Use execute instead for JavaScript, google.execute, memory.*, or fs.* runtime work.",
        inputSchema: z.object({
          command: z.string(),
          cwd: z.string().optional(),
          stdin: z.string().optional(),
        }),
        execute: async (input) => {
          const writes: string[] = [];
          return runTool(
            "bash",
            input as Record<string, unknown>,
            async () =>
              executeBash(
                { command: input.command, cwd: input.cwd, stdin: input.stdin },
                {
                  config: {
                    execMaxOutputBytes: this.getCodeExecutionConfig().limits.execMaxOutputBytes,
                    netRequestTimeoutMs: this.getCodeExecutionConfig().limits.netRequestTimeoutMs,
                    netMaxResponseBytes: this.getCodeExecutionConfig().limits.netMaxResponseBytes,
                    netMaxRedirects: this.getCodeExecutionConfig().limits.netMaxRedirects,
                    vfsMaxFiles: this.getCodeExecutionConfig().limits.vfsMaxFiles,
                  },
                  vfs: this.createVfsAdapter(writes),
                },
              ),
            writes,
          );
        },
      }),
      execute: tool({
        description:
          "Run JavaScript in a sandboxed Worker runtime with async/await, fetch, fs.read/fs.write/fs.list/fs.remove, memory.*, and built-in global `google`. Return the final value explicitly. VFS is file storage exposed through fs.* only. For repeated logic, keep code inline or copy in the small helper you need. For user-facing report tasks, prefer returning a final string summary. Load relevant skills first for specialized guidance.",
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
                  loader: this.env.LOADER ?? null,
                  host: this.createExecuteHostBinding(params.threadId, params.chatId),
                },
              ),
            writes,
          );
          return result;
        },
      }),
    };
  }

  private async recoverTimedOutRun(params: {
    model: ReturnType<BotRuntime["createModel"]>;
    userText: string;
    toolTraces: ToolTrace[];
  }) {
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
    return this.getWorkspace().listSkills();
  }

  private async getLoadedSkills(names: string[]): Promise<SkillRecord[]> {
    const loaded: SkillRecord[] = [];
    for (const name of names) {
      const skill = await this.getWorkspace().loadSkill(name);
      if (skill) loaded.push(skill);
    }
    return loaded;
  }

  private async writeWorkspaceFile(
    path: string,
    content: string,
    overwrite: boolean,
    writes?: string[],
  ) {
    const workspace = this.getWorkspace();
    const normalized = workspace.normalizePath(path);
    writes?.push(`write ${normalized}`);
    return workspace.writeFile(normalized, content, overwrite);
  }

  private async deleteWorkspaceFile(path: string, writes?: string[]): Promise<boolean> {
    const workspace = this.getWorkspace();
    const normalized = workspace.normalizePath(path);
    writes?.push(`remove ${normalized}`);
    return workspace.removeFile(normalized);
  }

  private createVfsAdapter(writes: string[]) {
    const workspace = this.getWorkspace();
    return {
      readFile: async (path: string) => workspace.readFile(path),
      writeFile: async (path: string, content: string, overwrite: boolean) =>
        this.writeWorkspaceFile(path, content, overwrite, writes),
      listFiles: async (prefix: string, limit: number) => workspace.listFiles(prefix, limit),
      removeFile: async (path: string) => this.deleteWorkspaceFile(path, writes),
      revision: async () => workspace.getRevision(),
    };
  }

  private getWorkspace() {
    return createWorkspace({
      db: this.env.DRECLAW_DB,
      maxFileBytes: this.getCodeExecutionConfig().limits.vfsMaxFileBytes,
    });
  }

  private getAgendaService(primaryChatId?: number | null) {
    return createAgendaService(this.env.DRECLAW_DB, {
      timezone: this.env.USER_TIMEZONE,
      primaryChatId: primaryChatId ?? null,
    });
  }

  private getCodeExecutionConfig() {
    return getCodeExecutionConfig(this.env as unknown as Record<string, string | undefined>);
  }

  private createExecuteHostBinding(threadId: string, chatId: number): ExecuteHostBinding | null {
    const factory = this.executionContext?.exports?.ExecuteHost;
    if (typeof factory !== "function") return null;
    const config = this.getCodeExecutionConfig();
    return factory({
      props: {
        threadId,
        chatId,
        limits: {
          execMaxOutputBytes: config.limits.execMaxOutputBytes,
          execMaxLogLines: config.limits.execMaxLogLines,
          netRequestTimeoutMs: config.limits.netRequestTimeoutMs,
          netMaxResponseBytes: config.limits.netMaxResponseBytes,
          vfsMaxFileBytes: config.limits.vfsMaxFileBytes,
          vfsListLimit: config.limits.vfsListLimit,
        },
        allowedGoogleServices: ["gmail", "drive", "sheets", "docs", "calendar"],
      },
    });
  }

  private getRuntimeConfig(): RuntimeConfig {
    const provider = (this.env.AI_PROVIDER?.trim().toLowerCase() || "opencode") as
      | "opencode"
      | "opencode-go"
      | "workers";
    const model =
      this.env.MODEL?.trim() || (provider === "workers" ? "@cf/zai-org/glm-4.7-flash" : "");
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
      baseUrl:
        this.env.BASE_URL?.trim() ||
        (provider === "opencode-go" ? OPENCODE_GO_BASE_URL : OPENCODE_ZEN_BASE_URL),
    };
  }

  private createModel(runtime: RuntimeConfig) {
    return runtime.provider === "workers"
      ? createWorkersModel(runtime.aiBinding, runtime.model)
      : createZenModel({ model: runtime.model, apiKey: runtime.apiKey, baseUrl: runtime.baseUrl });
  }

  private getAgentProviderOptions(
    runtime: RuntimeConfig,
  ): Record<string, Record<string, string>> | undefined {
    if (runtime.provider === "workers") return undefined;
    return {
      [runtime.provider]: { reasoningEffort: this.env.REASONING_EFFORT?.trim() || "medium" },
    };
  }

  private getMemoryConfigSafe() {
    try {
      return this.getMemoryRuntime().getConfig();
    } catch (error) {
      throw new Error(`Memory config error: ${compactErrorMessage(error)}`);
    }
  }

  private async executeMemoryFindPayload(chatId: number, payload: unknown): Promise<unknown> {
    return this.getMemoryRuntime().find({ chatId, payload });
  }

  private async executeMemorySavePayload(chatId: number, payload: unknown): Promise<unknown> {
    return this.getMemoryRuntime().save({ chatId, payload });
  }

  private async executeMemoryRemovePayload(chatId: number, payload: unknown): Promise<unknown> {
    return this.getMemoryRuntime().remove({ chatId, payload });
  }

  private async persistMemoryTurn(params: {
    chatId: number;
    userText: string;
    assistantText: string;
    toolTranscripts: string[];
    memoryTurns: number;
  }): Promise<void> {
    await this.getMemoryRuntime().persistTurn(params);
  }

  private getMemoryRuntime() {
    return createMemoryRuntime(this.env);
  }

  private google() {
    return createGooglePlugin(this.env);
  }
}

class VerboseTracer {
  constructor(
    private readonly db: D1Database,
    private readonly thread: Thread<BotThreadState>,
  ) {}

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

class NoopTracer implements ToolTracer {
  async onToolStart(): Promise<void> {
    return;
  }

  async onToolResult(): Promise<void> {
    return;
  }
}

function isRunCancelledError(error: unknown): error is RunCancelledError {
  return error instanceof RunCancelledError;
}

function buildAgentMessages(
  systemPrompt: string,
  userText: string,
  imageBlocks: string[],
): ModelMessage[] {
  const parts: Array<{ type: "text"; text: string } | { type: "image"; image: string }> = [];
  parts.push({ type: "text", text: userText || "[image message]" });
  for (const image of imageBlocks) parts.push({ type: "image", image });
  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: imageBlocks.length ? parts : userText || "[image message]" },
  ];
}

function isModelMessageArray(value: unknown): value is ModelMessage[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        item && typeof item === "object" && typeof (item as { role?: unknown }).role === "string",
    )
  );
}

function mergeContinuationMessages(
  base: ModelMessage[],
  continuation: ModelMessage[],
): ModelMessage[] {
  if (!continuation.length) return base;
  if (continuation.length >= base.length) {
    const prefix = continuation.slice(0, base.length);
    if (JSON.stringify(prefix) === JSON.stringify(base)) return continuation;
  }
  return [...base, ...continuation];
}

function renderHistoryContext(history: BotThreadState["history"]): string {
  if (!history.length) return "";
  return history.map((entry) => `${entry.role}: ${entry.content}`).join("\n");
}

function renderWakePacket(item: AssistantAgendaItem, recentWakeSummaries: string[]): string {
  return [
    "Proactive wake packet:",
    `title: ${item.title}`,
    `kind: ${item.kind}`,
    `priority: ${item.priority}`,
    `notes: ${item.notes || "-"}`,
    `scheduled_for: ${item.nextWakeAt ?? "-"}`,
    recentWakeSummaries.length
      ? `recent_runs:\n${recentWakeSummaries.map((entry) => `- ${entry}`).join("\n")}`
      : "recent_runs: -",
  ].join("\n");
}

function normalizeProactiveMessage(text: string): string | null {
  const normalized = String(text ?? "").trim();
  if (!normalized || normalized === PROACTIVE_NO_MESSAGE) return null;
  return normalized;
}

function summarizeProactiveWake(
  item: AssistantAgendaItem,
  messageText: string | null,
  toolTraces: ToolTrace[],
): string {
  if (messageText) return messageText;
  const successful = toolTraces.filter((trace) => trace.ok).length;
  const failed = toolTraces.length - successful;
  return `${item.title} | silent wake | tools ok=${successful} failed=${failed}`;
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
  if (/bash|shell|curl|grep|sed|awk|jq|yq|find|xargs|pipe|regex/.test(text)) {
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

function inferImplicitSkillNames(userText: string): string[] {
  const text = String(userText ?? "").toLowerCase();
  const names = new Set<string>();
  if (/gmail|email|inbox|calendar|drive|docs|sheets|google/.test(text)) {
    names.add("google");
    names.add("execute-runtime");
  }
  if (/script|helper|vfs|file/.test(text)) {
    names.add("vfs");
    names.add("execute-runtime");
  }
  if (/memory|remember|label/.test(text)) names.add("memory");
  if (/skill|workflow/.test(text)) names.add("skill-authoring");
  return [...names];
}

function renderTaskGuidance(userText: string): string {
  const text = String(userText ?? "").toLowerCase();
  const lines: string[] = [];
  if (/bash|shell|curl|grep|sed|awk|jq|yq|find|xargs|pipe|regex/.test(text)) {
    lines.push(
      "- Prefer bash for shell pipelines, curl, jq/yq, grep/sed/awk, and file-oriented text processing.",
    );
    lines.push(
      "- Prefer execute only when the task needs JavaScript, google.execute, memory.*, or fs.* runtime work.",
    );
  }
  if (/gmail|email|inbox/.test(text)) {
    lines.push("- For Gmail summaries, use at most one google.execute call per execute run.");
    lines.push(
      "- Good pattern: one execute run to list ids, one execute run per message detail, one final execute run to format a string summary.",
    );
    lines.push(
      "- For detail fetch runs, do not use return JSON.stringify({ ... }). Assign fields to const vars and return a plain string.",
    );
    lines.push(
      "- If one execute script fails, rewrite it to the simplest plain-string form on the next try.",
    );
  }
  if (/calendar/.test(text)) {
    lines.push(
      "- For Calendar tasks, prefer one focused execute run per API step and return a final string summary.",
    );
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
  if (name === "load_skill") {
    const skillName = typeof args.name === "string" ? args.name : serializeUnknown(args.name);
    return `Tool: ${name}\nname: ${skillName}`;
  }
  if (name === "list_skills") return `Tool: ${name}`;
  if (name === "vfs") {
    const action = typeof args.action === "string" ? args.action : serializeUnknown(args.action);
    const path = typeof args.path === "string" ? `\npath: ${args.path}` : "";
    const prefix = typeof args.prefix === "string" ? `\nprefix: ${args.prefix}` : "";
    return `Tool: ${name}\naction: ${action}${path}${prefix}`;
  }
  if (name === "bash") {
    const command = typeof args.command === "string" ? args.command : "";
    const cwd = typeof args.cwd === "string" ? `\ncwd: ${args.cwd}` : "";
    const stdin =
      typeof args.stdin === "string" && args.stdin
        ? `\nstdin: ${redactSensitiveText(args.stdin)}`
        : "";
    return `Tool: ${name}\n\n\`\`\`bash\n${command}\n\`\`\`${cwd}${stdin}`;
  }
  if (name === "execute") {
    const code = typeof args.code === "string" ? args.code : "";
    const input = Object.prototype.hasOwnProperty.call(args, "input")
      ? `\ninput: ${redactSensitiveText(serializeUnknown(args.input))}`
      : "";
    return `Tool: ${name}\n\n\`\`\`js\n${code}\n\`\`\`${input}`;
  }
  return `Tool: ${name}\nargs: ${redactSensitiveText(serializeUnknown(args))}`;
}

function renderTraceResult(trace: ToolTrace): string {
  const executeOk =
    trace.name === "execute" &&
    trace.output &&
    typeof trace.output === "object" &&
    "ok" in (trace.output as Record<string, unknown>)
      ? Boolean((trace.output as Record<string, unknown>).ok)
      : trace.ok;
  const lines = [`Tool result: ${trace.name} ${trace.ok ? "ok" : "failed"}`];
  lines[0] = `Tool result: ${trace.name} ${executeOk ? "ok" : "failed"}`;
  if (trace.ok && trace.name === "load_skill" && trace.output && typeof trace.output === "object") {
    const output = trace.output as Record<string, unknown>;
    lines.push(`loaded: ${serializeUnknown(output.name)}`);
    lines.push(`scope: ${serializeUnknown(output.scope)}`);
    lines.push(`path: ${serializeUnknown(output.path)}`);
    return lines.join("\n");
  }
  if (
    trace.ok &&
    trace.name === "list_skills" &&
    trace.output &&
    typeof trace.output === "object"
  ) {
    const skills = Array.isArray((trace.output as { skills?: unknown[] }).skills)
      ? ((trace.output as { skills: unknown[] }).skills as unknown[])
      : [];
    lines.push(`skills: ${skills.length}`);
    lines.push(
      `result: ${redactSensitiveText(truncateForLog(serializeUnknown(trace.output), 600))}`,
    );
    return lines.join("\n");
  }
  if (trace.ok && trace.name === "vfs") {
    lines.push(
      `result: ${redactSensitiveText(truncateForLog(serializeUnknown(trace.output), 1200))}`,
    );
    return lines.join("\n");
  }
  if (trace.writes?.length) lines.push(`writes: ${trace.writes.join(", ")}`);
  if (trace.ok)
    lines.push(
      `result: ${redactSensitiveText(truncateForLog(serializeUnknown(trace.output), 1200))}`,
    );
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

function truncateForLog(input: string, max: number): string {
  const compact = String(input ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!compact) return "";
  return compact.length <= max ? compact : `${compact.slice(0, max - 1)}…`;
}

function compactErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  if (typeof error === "number" || typeof error === "boolean" || typeof error === "bigint") {
    return `${error}`;
  }
  if (typeof error === "symbol") return error.description ?? "Symbol";
  try {
    return JSON.stringify(error);
  } catch {
    return error == null ? "unknown error" : Object.prototype.toString.call(error);
  }
}

function serializeUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return `${value}`;
  }
  if (typeof value === "symbol") return value.description ?? "Symbol";
  try {
    return JSON.stringify(value);
  } catch {
    return value == null ? "" : Object.prototype.toString.call(value);
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
