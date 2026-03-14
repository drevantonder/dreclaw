import { markUpdateSeen } from "../db";
import type { Env, TelegramUpdate } from "../types";
import { hasValidTelegramWebhookSecret } from "./auth";
import { maybeHandleAsyncTelegramCommand } from "./commands";
import { createBot } from "./gateway";

export async function handleTelegramWebhookRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  if (!hasValidTelegramWebhookSecret(request, env)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const update = (await request
    .clone()
    .json()
    .catch(() => null)) as TelegramUpdate | null;
  const firstSeen = update?.update_id
    ? await markUpdateSeen(env.DRECLAW_DB, update.update_id)
    : true;
  if (!firstSeen) return new Response("ok");

  if (
    update &&
    (await maybeHandleAsyncTelegramCommand(env, update, (task) => ctx.waitUntil(task), ctx))
  ) {
    return new Response("ok");
  }

  const bot = createBot(env, ctx);
  return bot.webhooks.telegram(request, {
    waitUntil: (task) => ctx.waitUntil(task),
  });
}
