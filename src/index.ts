import { markUpdateSeen } from "./db";
import { SessionRuntime } from "./session";
import { sendTelegramMessage } from "./telegram";
import { processTelegramUpdate } from "./telegram-update-processor";
import type { Env } from "./types";

export { SessionRuntime };

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ ok: true, service: "dreclaw", ts: Date.now() });
    }

    if (request.method === "POST" && url.pathname === "/telegram/webhook") {
      return handleTelegramWebhook(request, env);
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;

async function handleTelegramWebhook(request: Request, env: Env): Promise<Response> {
  const secret = request.headers.get("x-telegram-bot-api-secret-token");
  if (!secret || secret !== env.TELEGRAM_WEBHOOK_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  const body = await request.json();
  const result = await processTelegramUpdate(
    {
      body,
      allowedUserId: env.TELEGRAM_ALLOWED_USER_ID,
    },
    {
      markUpdateSeen: (updateId) => markUpdateSeen(env.DRECLAW_DB, updateId),
      runSession: async (sessionRequest) => {
        const id = env.SESSION_RUNTIME.idFromName(String(sessionRequest.message.chat.id));
        const stub = env.SESSION_RUNTIME.get(id);
        const response = await stub.fetch("https://session.local/run", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(sessionRequest),
        });
        return (await response.json()) as { ok: boolean; text: string };
      },
    },
  );

  if (result.status === "reply") {
    await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, result.reply.chatId, result.reply.text);
  }

  return new Response("ok");
}
