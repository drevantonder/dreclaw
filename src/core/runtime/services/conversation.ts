import { ToolLoopAgent, stepCountIs, type ModelMessage } from "ai";
import type { Message, Thread } from "chat";
import { streamTelegramReply } from "../../../chat-adapters/telegram/api";
import type { RuntimeDeps } from "../../app/types";
import type { Profiler } from "../../profiling";
import { renderLoadedSkill, renderSkillCatalog } from "../../skills";
import { normalizeCodeRuntimeState } from "../../tools/code-exec";
import { withTimeout } from "../../../utils/async";
import { isRunCancelledError } from "../lib/errors";
import {
  MEMORY_EPISODE_TOP_K,
  MEMORY_FACT_TOP_K,
  SYSTEM_PROMPT,
  buildAgentMessages,
  inferImplicitSkillNames,
  renderHistoryContext,
  renderTaskGuidance,
  shouldEnableAgentTools,
  shouldIncludeMemoryContext,
} from "../prompting";
import { VerboseTracer, renderToolTranscript, type ToolTrace } from "../tools/tracing";
import { createRunCoordinator } from "../../loop/run";
import { normalizeBotThreadState, pushHistory, type BotThreadState } from "../../loop/state";
import type { MemoryGateway } from "../adapters/memory";
import {
  createRuntimeModel,
  getAgentProviderOptions,
  getMaxOutputTokens,
  getRunSliceSteps,
  getRunTimeoutMs,
  getRuntimeConfig,
  getTypingPulseMs,
} from "../policy/model";
import { isModelMessageArray, mergeContinuationMessages } from "../lib/messages";
import type { CreateAgentTools } from "../tools/toolbox";
import type { WorkspaceGateway } from "../adapters/workspace";

function stripEphemeralState(state: BotThreadState): BotThreadState {
  return {
    ...state,
    codeRuntime: normalizeCodeRuntimeState(undefined),
    loadedSkills: [],
  };
}

export interface ConversationLoopService {
  runConversationInline(params: {
    thread: Thread<BotThreadState>;
    message: Message;
    chatId: number;
    state: BotThreadState;
    imageBlocks?: string[];
    maxSlices?: number;
  }): Promise<BotThreadState>;
  runConversationStep(params: {
    thread: Thread<BotThreadState>;
    message: Message;
    chatId: number;
    state: BotThreadState;
    runTimeoutMs?: number;
    baseMessages?: ModelMessage[];
    isFirstStep?: boolean;
    imageBlocks?: string[];
    profiler?: Profiler;
    stepIndex?: number;
  }): Promise<{ state: BotThreadState; nextMessages: ModelMessage[]; shouldContinue: boolean }>;
}

export function createConversationLoopService(params: {
  runtimeDeps: RuntimeDeps;
  runs: ReturnType<typeof createRunCoordinator>;
  workspaceGateway: WorkspaceGateway;
  memoryGateway: MemoryGateway;
  createTools: CreateAgentTools;
}): ConversationLoopService {
  return {
    async runConversationInline(input) {
      let state = params.runs.startRun(normalizeBotThreadState(input.state));
      state = await params.runs.recoverState(input.thread.id, state);
      await input.thread.setState(stripEphemeralState(state), { replace: true });
      await params.runs.persistRunState(input.thread.id, state);

      let messages: ModelMessage[] | undefined;
      let shouldContinue = true;
      const maxSlices = input.maxSlices ?? 6;
      for (let stepIndex = 0; stepIndex < maxSlices && shouldContinue; stepIndex += 1) {
        const result = await this.runConversationStep({
          thread: input.thread,
          message: input.message,
          chatId: input.chatId,
          state,
          imageBlocks: input.imageBlocks,
          baseMessages: messages,
          isFirstStep: stepIndex === 0,
          runTimeoutMs: getRunTimeoutMs(input.message.text.trim()),
          stepIndex,
        });
        state = result.state;
        messages = result.nextMessages;
        shouldContinue = result.shouldContinue;
      }

      if (shouldContinue) {
        state = params.runs.finishRun(state);
        await params.runs.persistRunState(input.thread.id, state);
      }

      return stripEphemeralState(state);
    },

    async runConversationStep(input) {
      const { thread, message } = input;
      let state = normalizeBotThreadState(input.state);
      const userText = message.text.trim();
      const imageBlocks = input.imageBlocks ?? [];
      const runtime = getRuntimeConfig(params.runtimeDeps);
      const toolTraces: ToolTrace[] = [];
      const tracer = new VerboseTracer(params.runtimeDeps.DRECLAW_DB, thread);
      const model = createRuntimeModel(runtime);
      const enableTools = shouldEnableAgentTools(userText);
      const includeMemory = shouldIncludeMemoryContext(userText);
      const inputMessages = isModelMessageArray(input.baseMessages)
        ? input.baseMessages
        : await buildConversationMessages({
            chatId: input.chatId,
            state,
            userText,
            imageBlocks,
            includeSkills: enableTools,
            includeMemory,
            profiler: input.profiler,
            workspaceGateway: params.workspaceGateway,
            memoryGateway: params.memoryGateway,
          });
      const runTimeoutMs = input.runTimeoutMs ?? getRunTimeoutMs(userText);
      let stepHadToolCalls = false;
      let stepText = "";

      const agent = new ToolLoopAgent({
        model,
        stopWhen: stepCountIs(getRunSliceSteps(params.runtimeDeps.RUN_SLICE_STEPS)),
        maxOutputTokens: getMaxOutputTokens(runtime, "conversation"),
        providerOptions: getAgentProviderOptions(runtime, params.runtimeDeps.REASONING_EFFORT),
        tools: enableTools
          ? params.createTools({
              chatId: input.chatId,
              threadId: thread.id,
              tracer,
              toolTraces,
            })
          : {},
      });

      const heartbeat = params.runs.createHeartbeat({
        thread,
        getState: () => state,
        setState: (nextState) => {
          state = nextState;
        },
        serializeState: stripEphemeralState,
        intervalMs: getTypingPulseMs(params.runtimeDeps.TYPING_PULSE_MS),
      });

      try {
        await thread.startTyping();
      } catch {
        // noop
      }
      heartbeat.start();

      try {
        await params.runs.throwIfCancelled(thread.id);
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
        const streamedText = await withTimeout(
          streamAssistantReply({
            thread,
            chatId: input.chatId,
            textStream: stream.textStream,
            profiler: input.profiler,
            telegramToken: params.runtimeDeps.TELEGRAM_BOT_TOKEN,
          }),
          runTimeoutMs,
          "Assistant stream timed out",
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
        await params.runs.throwIfCancelled(thread.id);
        const responseMessages = isModelMessageArray(response.messages) ? response.messages : [];
        const nextMessages = mergeContinuationMessages(inputMessages, responseMessages);

        heartbeat.stop();
        if (input.isFirstStep) state = pushHistory(state, "user", userText || "[image]");
        for (const trace of toolTraces) {
          state = pushHistory(state, "tool", renderToolTranscript(trace));
        }

        const assistantCandidate = [text, streamedText, stepText].find(
          (value): value is string => typeof value === "string" && value.trim().length > 0,
        );
        const assistantText = assistantCandidate?.trim() ?? "";
        if (assistantText && !stepHadToolCalls && !streamedText) {
          try {
            await thread.post(assistantText);
          } catch {
            // noop
          }
          state = pushHistory(state, "assistant", assistantText);
        } else if (assistantText && !stepHadToolCalls) {
          state = pushHistory(state, "assistant", assistantText);
        }
        if (!stepHadToolCalls) {
          state = params.runs.finishRun(state);
          await params.runs.persistRunState(thread.id, state);
        }
        return {
          state: stripEphemeralState(state),
          nextMessages,
          shouldContinue: stepHadToolCalls,
        };
      } catch (error) {
        heartbeat.stop();
        if (isRunCancelledError(error)) {
          state = params.runs.finishRun(state);
          await params.runs.persistRunState(thread.id, state);
          return {
            state: stripEphemeralState(state),
            nextMessages: inputMessages,
            shouldContinue: false,
          };
        }
        throw error;
      }
    },
  };
}

async function buildConversationMessages(params: {
  chatId: number;
  state: BotThreadState;
  userText: string;
  imageBlocks: string[];
  includeSkills?: boolean;
  includeMemory?: boolean;
  profiler?: Profiler;
  workspaceGateway: WorkspaceGateway;
  memoryGateway: MemoryGateway;
}) {
  const promptSections = [SYSTEM_PROMPT, `Current date/time (UTC): ${new Date().toISOString()}`];
  if (params.includeSkills !== false) {
    const skillCatalog = params.profiler
      ? await params.profiler.span("list_skills", async () => params.workspaceGateway.listSkills())
      : await params.workspaceGateway.listSkills();
    promptSections.push(`Available skills:\n${renderSkillCatalog(skillCatalog)}`);
    const loadedSkills = params.profiler
      ? await params.profiler.span("load_skills", async () =>
          params.workspaceGateway.getLoadedSkills(inferImplicitSkillNames(params.userText)),
        )
      : await params.workspaceGateway.getLoadedSkills(inferImplicitSkillNames(params.userText));
    if (loadedSkills.length) {
      promptSections.push(`Loaded skills:\n${loadedSkills.map(renderLoadedSkill).join("\n\n")}`);
    }
  }
  const taskGuidance = renderTaskGuidance(params.userText);
  if (taskGuidance) promptSections.push(`Task guidance:\n${taskGuidance}`);
  const historyContext = renderHistoryContext(params.state.history);
  if (historyContext) promptSections.push(`Recent context:\n${historyContext}`);
  if (params.includeMemory !== false) {
    const memoryContext = params.profiler
      ? await params.profiler.span("memory_context", async () =>
          params.memoryGateway.renderContext({
            chatId: params.chatId,
            query: params.userText || "[image message]",
            factTopK: MEMORY_FACT_TOP_K,
            episodeTopK: MEMORY_EPISODE_TOP_K,
          }),
        )
      : await params.memoryGateway.renderContext({
          chatId: params.chatId,
          query: params.userText || "[image message]",
          factTopK: MEMORY_FACT_TOP_K,
          episodeTopK: MEMORY_EPISODE_TOP_K,
        });
    if (memoryContext) promptSections.push(`Memory context:\n${memoryContext}`);
  }
  return buildAgentMessages(promptSections.join("\n\n"), params.userText, params.imageBlocks);
}

async function streamAssistantReply(params: {
  thread: Thread<BotThreadState>;
  chatId: number;
  textStream: AsyncIterable<string>;
  profiler?: Profiler;
  telegramToken: string;
}): Promise<string> {
  if (params.thread.id.startsWith("telegram:")) {
    const result = await streamTelegramReply({
      token: params.telegramToken,
      chatId: params.chatId,
      textStream: params.textStream,
      profiler: params.profiler,
    });
    return result.text;
  }

  await params.thread.post(params.textStream);
  return "";
}
