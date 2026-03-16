import { ToolLoopAgent, generateText, stepCountIs } from "ai";
import type { Reminder } from "../../../plugins/reminders";
import type { RuntimeDeps } from "../../app/types";
import { renderLoadedSkill, renderSkillCatalog } from "../../skills";
import { normalizeCodeRuntimeState } from "../../tools/code-exec";
import { withTimeout } from "../async-utils";
import { extractAssistantText } from "../message-utils";
import {
  DEFAULT_RUN_TIMEOUT_MS,
  createRuntimeModel,
  getAgentProviderOptions,
  getMaxOutputTokens,
  getRuntimeConfig,
} from "../model-policy";
import {
  MEMORY_EPISODE_TOP_K,
  MEMORY_FACT_TOP_K,
  PROACTIVE_NO_MESSAGE,
  SYSTEM_PROMPT,
  buildAgentMessages,
  inferImplicitSkillNames,
  normalizeProactiveMessage,
  renderHistoryContext,
  renderWakePacket,
  summarizeProactiveWake,
} from "../prompting";
import { NoopTracer, renderToolTranscript, type ToolTrace } from "../tracing";
import type { MemoryGateway } from "../memory-gateway";
import { createRunCoordinator } from "../run";
import { normalizeBotThreadState, pushHistory, type BotThreadState } from "../state";
import type { CreateAgentTools } from "../toolbox";
import type { WorkspaceGateway } from "../workspace-gateway";

function stripEphemeralState(state: BotThreadState): BotThreadState {
  return {
    ...state,
    codeRuntime: normalizeCodeRuntimeState(undefined),
    loadedSkills: [],
  };
}

export interface ProactiveWakeService {
  runProactiveWake(params: {
    threadId: string;
    chatId: number;
    state: BotThreadState;
    item: Reminder;
    recentWakeSummaries: string[];
  }): Promise<{ state: BotThreadState; messageText: string | null; summary: string }>;
}

export function createProactiveWakeService(params: {
  runtimeDeps: RuntimeDeps;
  runs: ReturnType<typeof createRunCoordinator>;
  workspaceGateway: WorkspaceGateway;
  memoryGateway: MemoryGateway;
  createTools: CreateAgentTools;
}): ProactiveWakeService {
  return {
    async runProactiveWake(input) {
      let state = normalizeBotThreadState(input.state);
      const runtime = getRuntimeConfig(params.runtimeDeps);
      const toolTraces: ToolTrace[] = [];
      const model = createRuntimeModel(runtime);
      const wakePacket = renderWakePacket(input.item, input.recentWakeSummaries);
      const promptSections = [
        SYSTEM_PROMPT,
        [
          "You are waking proactively on your own reminders.",
          "You woke because an internal reminder became due.",
          `If no user-facing message is needed after any background work, reply exactly with ${PROACTIVE_NO_MESSAGE}.`,
          "If a message is useful, make it concise and action-oriented.",
          "Keep your reminders tidy by updating, rescheduling, snoozing, or completing items.",
        ].join(" "),
        `Current date/time (UTC): ${new Date().toISOString()}`,
      ];
      const skillCatalog = await params.workspaceGateway.listSkills();
      promptSections.push(`Available skills:\n${renderSkillCatalog(skillCatalog)}`);
      const loadedSkills = await params.workspaceGateway.getLoadedSkills(
        inferImplicitSkillNames(wakePacket),
      );
      if (loadedSkills.length) {
        promptSections.push(`Loaded skills:\n${loadedSkills.map(renderLoadedSkill).join("\n\n")}`);
      }
      const historyContext = renderHistoryContext(state.history);
      if (historyContext) promptSections.push(`Recent context:\n${historyContext}`);
      const memoryContext = await params.memoryGateway.renderContext({
        chatId: input.chatId,
        query: `${input.item.title}\n${input.item.notes}`.trim() || "[reminder wake]",
        factTopK: MEMORY_FACT_TOP_K,
        episodeTopK: MEMORY_EPISODE_TOP_K,
      });
      if (memoryContext) promptSections.push(`Memory context:\n${memoryContext}`);

      const agent = new ToolLoopAgent({
        model,
        stopWhen: stepCountIs(8),
        maxOutputTokens: getMaxOutputTokens(runtime, "reminder"),
        providerOptions: getAgentProviderOptions(runtime, params.runtimeDeps.REASONING_EFFORT),
        tools: params.createTools({
          chatId: input.chatId,
          threadId: input.threadId,
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
          extractAssistantText((response.messages as never[]) ?? []);
      } catch {
        finalText = await recoverTimedOutRun({
          model,
          userText: wakePacket,
          toolTraces,
          runtime,
          configuredReasoningEffort: params.runtimeDeps.REASONING_EFFORT,
        });
      }

      for (const trace of toolTraces)
        state = pushHistory(state, "tool", renderToolTranscript(trace));

      const messageText = normalizeProactiveMessage(finalText);
      if (messageText) state = pushHistory(state, "assistant", messageText);
      return {
        state: stripEphemeralState(state),
        messageText,
        summary: summarizeProactiveWake(input.item, messageText, toolTraces),
      };
    },
  };
}

async function recoverTimedOutRun(params: {
  model: ReturnType<typeof createRuntimeModel>;
  userText: string;
  toolTraces: ToolTrace[];
  runtime: ReturnType<typeof getRuntimeConfig>;
  configuredReasoningEffort?: string;
}) {
  const successfulToolTraces = params.toolTraces.filter((trace) => trace.ok);
  if (successfulToolTraces.length) {
    try {
      const result = await withTimeout(
        generateText({
          model: params.model,
          maxOutputTokens: getMaxOutputTokens(params.runtime, "recovery"),
          providerOptions: getAgentProviderOptions(
            params.runtime,
            params.configuredReasoningEffort,
          ),
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
