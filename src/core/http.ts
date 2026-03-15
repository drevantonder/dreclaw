import type { Env } from "../cloudflare/env";
import { sendTelegramTextMessage } from "../chat-adapters/telegram/api";
import { handleTelegramWebhookRequest } from "../chat-adapters/telegram/webhook";
import { createPluginRegistry } from "./plugins/registry";

export async function handleWorkerFetch(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/health") {
    return Response.json({ ok: true, service: "dreclaw", ts: Date.now() });
  }

  if (request.method === "POST" && url.pathname === "/telegram/webhook") {
    return handleTelegramWebhookRequest(request, env, ctx);
  }

  if (request.method === "GET" && url.pathname === "/google/oauth/callback") {
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

function htmlResponse(status: number, title: string, body: string): Response {
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(body)}</p></body></html>`,
    {
      status,
      headers: { "content-type": "text/html; charset=utf-8" },
    },
  );
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
