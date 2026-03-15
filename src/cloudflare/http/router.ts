import type { Env } from "../env";
import { handleTelegramWebhookRequest } from "../../chat-adapters/telegram/webhook";
import { sendTelegramTextMessage } from "../../chat-adapters/telegram/api";
import { getHealthPayload, handlePluginOAuthCallback } from "../../core/http";
import { htmlResponse } from "./response";

export async function handleHttpRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/health") {
    return Response.json(getHealthPayload());
  }

  if (request.method === "POST" && url.pathname === "/telegram/webhook") {
    return handleTelegramWebhookRequest(request, env, ctx);
  }

  if (request.method === "GET" && url.pathname === "/google/oauth/callback") {
    const result = await handlePluginOAuthCallback(env, "google", request);
    if (!result) return new Response("Not found", { status: 404 });
    if (result.notifyTelegram) {
      try {
        await sendTelegramTextMessage(
          env.TELEGRAM_BOT_TOKEN,
          result.notifyTelegram.chatId,
          result.notifyTelegram.text,
        );
      } catch (error) {
        console.warn("google-oauth-telegram-notify-failed", {
          chatId: result.notifyTelegram.chatId,
          error:
            error instanceof Error ? error.message : typeof error === "string" ? error : "unknown",
        });
      }
    }
    return htmlResponse(result.status, result.title, result.body);
  }

  return new Response("Not found", { status: 404 });
}
