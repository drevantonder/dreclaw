import { markUpdateSeen } from "./db";
import { SessionRuntime } from "./session";
import { parseUpdate, sendTelegramMessage } from "./telegram";
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

  const json = await request.json();
  const update = parseUpdate(json);
  if (!update) return new Response("ok");

  const unseen = await markUpdateSeen(env.DRECLAW_DB, update.update_id);
  if (!unseen) return new Response("ok");
  if (!update.message) return new Response("ok");

  const message = update.message;
  if (message.chat.type !== "private") return new Response("ok");
  if (!message.from || String(message.from.id) !== env.TELEGRAM_ALLOWED_USER_ID) return new Response("ok");

  const id = env.SESSION_RUNTIME.idFromName(String(message.chat.id));
  const stub = env.SESSION_RUNTIME.get(id);
  const result = await stub.fetch("https://session.local/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ updateId: update.update_id, message }),
  });

  const payload = (await result.json()) as { ok: boolean; text: string };
  const text = payload.text || "Done.";
  await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, message.chat.id, text);
  return new Response("ok");
}
