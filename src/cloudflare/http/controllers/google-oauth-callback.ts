import { createPluginRegistry } from "../../../core";
import type { Env } from "../../env";
import { sendTelegramTextMessage } from "../../../chat-adapters/telegram/api";
import { htmlResponse } from "../response";

export async function handleGoogleOAuthCallbackRequest(
  request: Request,
  env: Env,
): Promise<Response> {
  const handler = createPluginRegistry(env).getOAuthCallbackHandler("google");
  if (!handler) return new Response("Not found", { status: 404 });
  const result = await handler(request);
  if (result.notifyTelegram) {
    try {
      await sendTelegramTextMessage(
        env.TELEGRAM_BOT_TOKEN,
        result.notifyTelegram.chatId,
        result.notifyTelegram.text,
      );
    } catch {
      // noop
    }
  }
  return htmlResponse(result.status, result.title, result.body);
}
