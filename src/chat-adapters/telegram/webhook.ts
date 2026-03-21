import {
  createProfiler,
  parseProfilingEnabled,
  parseProfilingSampleRate,
} from "../../core/profiling";
import type { Env } from "../../cloudflare/env";
import { sendTelegramTypingAction } from "./api";
import { hasValidTelegramWebhookSecret } from "./auth";
import { maybeHandleAsyncTelegramCommand } from "./commands";
import {
  isPrivateTelegramUpdate,
  loadTelegramImageBlocks,
  serializeTelegramMessage,
} from "./message";
import { markUpdateSeen } from "./repo";
import type { TelegramUpdate } from "./types";
import { createBot, rememberTelegramExecutionContext } from "./gateway";
import { enqueueChatInboxMessage, getThreadStateSnapshot } from "../../core/loop/repo";
import { createRunCoordinator } from "../../core/loop/run";
import { normalizeBotThreadState } from "../../core/loop/state";

export async function handleTelegramWebhookRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const profiler = createProfiler({
    enabled: parseProfilingEnabled(env.PROFILING_ENABLED),
    sampleRate: parseProfilingSampleRate(env.PROFILING_SAMPLE_RATE),
    context: { channel: "telegram-webhook" },
  });
  if (!hasValidTelegramWebhookSecret(request, env)) {
    profiler.flush("telegram_webhook", { outcome: "unauthorized" });
    return new Response("Unauthorized", { status: 401 });
  }

  const update = (await profiler.span("parse_update_json", async () =>
    request
      .clone()
      .json()
      .catch(() => null),
  )) as TelegramUpdate | null;
  profiler.event("update_parsed", { updateId: update?.update_id ?? null });
  if (update?.message && isPrivateTelegramUpdate(update)) {
    rememberTelegramExecutionContext(update.message, ctx, profiler.traceId);
  }
  if (update?.message?.chat?.id && isPrivateTelegramUpdate(update)) {
    const chatId = update.message.chat.id;
    ctx.waitUntil(
      profiler
        .span("send_typing", async () =>
          sendTelegramTypingAction(env.TELEGRAM_BOT_TOKEN, chatId).catch(() => null),
        )
        .catch(() => null),
    );
  }
  const firstSeen = update?.update_id
    ? await profiler.span("dedupe_update", async () =>
        markUpdateSeen(env.DRECLAW_DB, update.update_id),
      )
    : true;
  if (!firstSeen) return new Response("ok");

  if (update?.message && isPrivateTelegramUpdate(update) && !isSlashCommandUpdate(update)) {
    const chatId = update.message.chat.id;
    const threadId = `telegram:${chatId}`;
    const runs = createRunCoordinator({
      db: env.DRECLAW_DB,
      workflow: env.CONVERSATION_WORKFLOW,
    });
    const state = normalizeBotThreadState(await getThreadStateSnapshot(env.DRECLAW_DB, threadId));
    const run = await runs.inspect(threadId, state);
    if (run.busy || (await hasActiveThreadLock(env.DRECLAW_DB, threadId))) {
      const imageBlocks = await loadTelegramImageBlocks(
        env.TELEGRAM_BOT_TOKEN,
        update.message,
      ).catch(() => []);
      await enqueueChatInboxMessage(env.DRECLAW_DB, {
        id: crypto.randomUUID(),
        chatId,
        updateId: update.update_id,
        textJson: JSON.stringify({
          message: serializeTelegramMessage(update, threadId),
          imageBlocks,
        }),
        nowIso: new Date().toISOString(),
      });
      profiler.flush("telegram_webhook", { outcome: "queued_busy_turn", chatId });
      return new Response("ok");
    }
  }

  if (
    update &&
    (await profiler.span("async_command_check", async () =>
      maybeHandleAsyncTelegramCommand(env, update, undefined, ctx),
    ))
  ) {
    profiler.flush("telegram_webhook", { outcome: "async_command" });
    return new Response("ok");
  }

  const bot = createBot(env, ctx);
  const response = await profiler.span("dispatch_bot_webhook", async () =>
    bot.webhooks.telegram(request, {
      waitUntil: (task) => ctx.waitUntil(task),
    }),
  );
  profiler.flush("telegram_webhook", { outcome: "dispatched" });
  return response;
}

function isSlashCommandUpdate(update: TelegramUpdate): boolean {
  const text = String(update.message?.text ?? update.message?.caption ?? "").trim();
  return text.startsWith("/");
}

async function hasActiveThreadLock(db: D1Database, threadId: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT thread_id FROM chat_state_locks WHERE thread_id = ? AND expires_at > ?")
    .bind(threadId, new Date().toISOString())
    .first<Record<string, unknown>>();
  return Boolean(row?.thread_id);
}
