import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { Message as ChatMessage, ThreadImpl } from "chat";
import { createChat } from "../chat-adapters/telegram/gateway";
import { sendTelegramTypingAction } from "../chat-adapters/telegram/api";
import { handleTelegramWebhookRequest as handleTelegramWebhookAdapter } from "../chat-adapters/telegram/webhook";
import { getTelegramUserChatId, loadTelegramImageBlocks } from "../chat-adapters/telegram/message";
import type { Env } from "../cloudflare/env";
import { getRemindersPlugin } from "../plugins/reminders";
import { handlePluginOAuthCallback, getHealthPayload } from "../core/http";
import {
  claimChatInboxMessages,
  getThreadStateSnapshot,
  releaseClaimedChatInboxMessage,
  setThreadStateSnapshot,
  type ChatInboxRecord,
} from "../core/loop/repo";
import { createLoopServices } from "../core/runtime";
import { normalizeBotThreadState, type BotThreadState } from "../core/loop/state";
import type {
  ConversationWorkflowPayload,
  QueuedConversationTurnPayload,
  ReminderWakeWorkflowPayload,
} from "../core/loop/workflow";
import { htmlResponse } from "../cloudflare/http/response";
import { buildRuntimeDeps } from "./deps";
import { flushTelegramEffects } from "./telegram";
import { createRunCoordinator } from "../core/loop/run";
import { createProfiler, parseProfilingEnabled, parseProfilingSampleRate } from "../core/profiling";
import { getRunTimeoutMs } from "../core/runtime/policy/model";
import { isRunCancelledError } from "../core/runtime/lib/errors";

export async function handleHttpRequest(request: Request, env: Env, ctx: ExecutionContext) {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/health") {
    return Response.json(getHealthPayload());
  }
  if (request.method === "POST" && url.pathname === "/telegram/webhook") {
    return handleTelegramWebhookAdapter(request, env, ctx);
  }
  if (request.method === "GET" && url.pathname === "/google/oauth/callback") {
    const runtimeDeps = buildRuntimeDeps(env);
    const result = await handlePluginOAuthCallback(runtimeDeps.pluginRegistry, "google", request);
    if (!result) return new Response("Not found", { status: 404 });
    await flushTelegramEffects(env, result.effects);
    return htmlResponse(result.status, result.title, result.body);
  }
  return new Response("Not found", { status: 404 });
}

export async function runConversationWorkflow(
  env: Env,
  ctx: ExecutionContext,
  event: WorkflowEvent<ConversationWorkflowPayload>,
  step: WorkflowStep,
): Promise<void> {
  const profiler = createProfiler({
    enabled: parseProfilingEnabled(env.PROFILING_ENABLED),
    sampleRate: parseProfilingSampleRate(env.PROFILING_SAMPLE_RATE),
    traceId: event.payload.traceId,
    context: { channel: "conversation-workflow" },
  });
  const runs = createRunCoordinator({ db: env.DRECLAW_DB, workflow: env.CONVERSATION_WORKFLOW });
  const runtimeDeps = buildRuntimeDeps(env);
  const chat = createChat(env).registerSingleton();
  void chat;
  const thread = ThreadImpl.fromJSON<BotThreadState>(event.payload.thread);
  const services = createLoopServices(runtimeDeps, ctx as never);
  profiler.event("workflow_started", { threadId: thread.id });
  let state = await profiler.span("restore_workflow_state", async () =>
    runs.restoreWorkflowState({
      threadId: thread.id,
      state: event.payload.state as BotThreadState,
      payloadState: event.payload.state,
    }),
  );
  let currentMessage = ChatMessage.fromJSON(event.payload.message);
  const chatId = event.payload.channelId ?? getTelegramUserChatId(currentMessage.raw, thread.id);
  const stopTypingPulse = startWorkflowTypingPulse({
    token: env.TELEGRAM_BOT_TOKEN,
    chatId,
    pulseMs: getTypingPulseMs(env.TYPING_PULSE_MS),
  });
  let currentImageBlocks =
    event.payload.imageBlocks ??
    (await profiler.span("load_telegram_images", async () =>
      loadTelegramImageBlocks(env.TELEGRAM_BOT_TOKEN, currentMessage.raw).catch(() => []),
    ));
  let currentClaimedInbox: ChatInboxRecord | null = null;
  const queueRunId =
    event.payload.state &&
    typeof (event.payload.state as { runStatus?: { workflowInstanceId?: string } }).runStatus
      ?.workflowInstanceId === "string"
      ? String(
          (event.payload.state as { runStatus?: { workflowInstanceId?: string } }).runStatus
            ?.workflowInstanceId,
        )
      : crypto.randomUUID();
  let outcome = "completed";
  try {
    while (true) {
      let messages: unknown[] | undefined;
      let shouldContinue = true;
      for (let stepIndex = 0; stepIndex < 64 && shouldContinue; stepIndex += 1) {
        await sendTelegramTypingAction(env.TELEGRAM_BOT_TOKEN, chatId).catch(() => null);
        const rawResult = await step.do(
          `conversation-step-${currentMessage.id}-${stepIndex}`,
          async () => {
            const stepResult = await services.conversation.runConversationStep({
              thread,
              message: currentMessage,
              chatId,
              state,
              imageBlocks: currentImageBlocks,
              baseMessages: Array.isArray(messages) ? (messages as any) : undefined,
              isFirstStep: stepIndex === 0,
              runTimeoutMs: Math.max(
                getWorkflowBurstMs(runtimeDeps, stepIndex === 0),
                getRunTimeoutMs(currentMessage.text.trim()),
              ),
              profiler,
              stepIndex,
            });
            await thread.setState(stepResult.state as any, { replace: true });
            return {
              stateJson: JSON.stringify(stepResult.state),
              nextMessagesJson: JSON.stringify(stepResult.nextMessages),
              shouldContinue: stepResult.shouldContinue,
            };
          },
        );
        const result = rawResult as {
          stateJson: string;
          nextMessagesJson: string;
          shouldContinue: boolean;
        };
        state = await runs.restoreWorkflowState({
          threadId: event.payload.thread.id,
          state,
          payloadState: JSON.parse(String(result.stateJson ?? "{}")),
        });
        messages = JSON.parse(String(result.nextMessagesJson ?? "[]")) as unknown[];
        shouldContinue = Boolean(result.shouldContinue);
      }

      await thread.setState(state as any, { replace: true });
      currentClaimedInbox = null;
      const nextQueued = await claimNextQueuedTurn(env.DRECLAW_DB, chatId, queueRunId);
      if (!nextQueued) break;
      currentClaimedInbox = nextQueued.record;
      state = runs.startRun(state, queueRunId);
      await Promise.all([
        thread.setState(state as any, { replace: true }),
        runs.persistRunState(thread.id, state),
      ]);
      currentMessage = ChatMessage.fromJSON(nextQueued.payload.message);
      currentImageBlocks = nextQueued.payload.imageBlocks;
    }

    await runs.clearWorkflowInstance(thread.id);
  } catch (error) {
    outcome = error instanceof Error ? error.message : "failed";
    if (currentClaimedInbox) {
      await releaseClaimedChatInboxMessage(env.DRECLAW_DB, {
        id: currentClaimedInbox.id,
        runId: queueRunId,
      }).catch(() => null);
    }
    const finishedState = runs.finishRun(state);
    await Promise.allSettled([
      thread.setState(finishedState as any, { replace: true }),
      runs.persistRunState(thread.id, finishedState),
      runs.clearWorkflowInstance(thread.id),
    ]);
    if (!isRunCancelledError(error)) {
      await flushTelegramEffects(env, [
        {
          type: "send-text",
          target: { channel: "telegram", id: String(chatId) },
          text: "I hit an internal error while handling that request. Please retry.",
        },
      ]).catch(() => null);
    }
    throw error;
  } finally {
    stopTypingPulse();
    profiler.flush("conversation_workflow", { outcome, threadId: thread.id, chatId });
  }
}

async function claimNextQueuedTurn(
  db: D1Database,
  chatId: number,
  runId: string,
): Promise<{ record: ChatInboxRecord; payload: QueuedConversationTurnPayload } | null> {
  const [record] = await claimChatInboxMessages(db, {
    chatId,
    runId,
    limit: 1,
    nowIso: new Date().toISOString(),
  });
  if (!record) return null;
  return {
    record,
    payload: JSON.parse(record.payloadJson) as QueuedConversationTurnPayload,
  };
}

export async function runRemindersWakeWorkflow(
  env: Env,
  ctx: ExecutionContext,
  event: WorkflowEvent<ReminderWakeWorkflowPayload>,
  step: WorkflowStep,
): Promise<void> {
  const runtimeDeps = buildRuntimeDeps(env);
  const reminders = getRemindersPlugin(runtimeDeps.pluginRegistry.getByName("reminders"));
  const item = await reminders.getReminder(event.payload.reminderId);
  if (!item || item.claimToken !== event.payload.claimToken) return;
  const profile = await reminders.ensureReminderProfile({
    primaryChatId: item.sourceChatId ?? null,
  });
  const chatId = item.sourceChatId ?? profile.primaryChatId;
  if (!chatId) {
    const runId = await reminders.openReminderWakeRun({
      reminderId: item.id,
      scheduledFor: item.nextWakeAt ?? new Date().toISOString(),
    });
    await reminders.finalizeReminderWake({
      itemId: item.id,
      claimToken: event.payload.claimToken,
      runId,
      scheduledFor: item.nextWakeAt ?? new Date().toISOString(),
      outcome: "failed",
      summary: "Missing primary chat id for proactive wake",
      error: "Missing primary chat id for proactive wake",
    });
    return;
  }
  const threadId = `telegram:${chatId}`;
  const runId = await reminders.openReminderWakeRun({
    reminderId: item.id,
    scheduledFor: item.nextWakeAt ?? new Date().toISOString(),
  });
  const recentWakeRuns = await reminders.listRecentReminderWakeRuns(item.id, 5);
  try {
    const result = await step.do("run-proactive-wake", async () => {
      const services = createLoopServices(runtimeDeps, ctx as never);
      const state = normalizeBotThreadState(await getThreadStateSnapshot(env.DRECLAW_DB, threadId));
      return services.wake.runProactiveWake({
        threadId,
        chatId,
        state,
        item,
        recentWakeSummaries: recentWakeRuns
          .filter((wakeRun) => wakeRun.summary)
          .map((wakeRun) => String(wakeRun.summary)),
      });
    });
    await setThreadStateSnapshot(env.DRECLAW_DB, threadId, result.state);
    if (result.messageText) {
      await flushTelegramEffects(env, [
        {
          type: "send-text",
          target: { channel: "telegram", id: String(chatId) },
          text: result.messageText,
        },
      ]);
    }
    await reminders.finalizeReminderWake({
      itemId: item.id,
      claimToken: event.payload.claimToken,
      runId,
      scheduledFor: item.nextWakeAt ?? new Date().toISOString(),
      outcome: result.messageText ? "sent_message" : "silent",
      summary: result.summary,
    });
  } catch (error) {
    await reminders.finalizeReminderWake({
      itemId: item.id,
      claimToken: event.payload.claimToken,
      runId,
      scheduledFor: item.nextWakeAt ?? new Date().toISOString(),
      outcome: "failed",
      summary: error instanceof Error ? error.message : "Proactive wake failed",
      error:
        error instanceof Error
          ? error.message
          : typeof error === "string"
            ? error
            : "Proactive wake failed",
    });
    throw error;
  }
}

function startWorkflowTypingPulse(params: { token: string; chatId: number; pulseMs: number }) {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const tick = async () => {
    if (stopped) return;
    await sendTelegramTypingAction(params.token, params.chatId).catch(() => null);
    if (!stopped) timer = setTimeout(() => void tick(), params.pulseMs);
  };

  void tick();

  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

function getTypingPulseMs(value: string | undefined): number {
  return parsePositiveMs(value, 2500);
}

function getWorkflowBurstMs(
  deps: { INLINE_BURST_MS?: string; QUEUE_BURST_MS?: string },
  isFirstStep: boolean,
) {
  return parsePositiveMs(
    isFirstStep ? deps.INLINE_BURST_MS : deps.QUEUE_BURST_MS,
    isFirstStep ? 8000 : 20000,
  );
}

function parsePositiveMs(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export async function handleScheduled(env: Env): Promise<void> {
  const runtimeDeps = buildRuntimeDeps(env);
  await runtimeDeps.pluginRegistry.runScheduled({ nowIso: new Date().toISOString() });
}
