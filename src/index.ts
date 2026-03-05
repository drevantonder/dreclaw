import {
  cancelActiveRunsForChat,
  clearPendingChatInbox,
  claimChatInboxMessages,
  claimAgentRunDelivery,
  createAgentRun,
  enqueueChatInboxMessage,
  getActiveAgentRunForChat,
  getAgentRun,
  getGoogleOAuthState,
  markAgentRunCompleted,
  updateAgentRunPayload,
  markAgentRunRetryableFailure,
  markAgentRunRunning,
  markGoogleOAuthStateUsed,
  markUpdateSeen,
  upsertGoogleOAuthToken,
} from "./db";
import { decodeEncryptionKey, encryptSecret } from "./crypto";
import { exchangeGoogleOAuthCode, getGoogleOAuthConfig } from "./google-oauth";
import { SessionRuntime } from "./session";
import { sendTelegramChatAction, sendTelegramMessage } from "./telegram";
import { processTelegramUpdate } from "./telegram-update-processor";
import type { Env, SessionRequest } from "./types";

export { SessionRuntime };

const WEBHOOK_MAX_BODY_BYTES = 256_000;
const GOOGLE_OAUTH_DEFAULT_PRINCIPAL = "default";
const RUN_MAX_ATTEMPTS = 5;
const RUN_QUEUE_KIND = "run.execute";
const DEFAULT_INLINE_BURST_MS = 3000;
const DEFAULT_QUEUE_BURST_MS = 9000;
const DEFAULT_TYPING_PULSE_MS = 3000;
const INBOX_CLAIM_LIMIT = 8;

interface QueueRunEnvelope {
  sessionRequest: SessionRequest;
  checkpoint?: {
    messages: unknown[];
    toolTranscripts: string[];
    imageBlocks: string[];
  };
}

interface QueueRunStepResult {
  done: boolean;
  text?: string;
  checkpoint?: QueueRunEnvelope["checkpoint"];
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return Response.json({ ok: true, service: "dreclaw", ts: Date.now() });
    }

    if (request.method === "POST" && url.pathname === "/telegram/webhook") {
      return handleTelegramWebhook(request, env, ctx);
    }

    if (request.method === "GET" && url.pathname === "/google/oauth/callback") {
      return handleGoogleOAuthCallback(request, env);
    }

    return new Response("Not found", { status: 404 });
  },
  async queue(batch, env): Promise<void> {
    for (const message of batch.messages) {
      const body = message.body as { type?: unknown; runId?: unknown };
      const type = typeof body?.type === "string" ? body.type : "";
      const runId = typeof body?.runId === "string" ? body.runId : "";
      if (type !== RUN_QUEUE_KIND || !runId) continue;
      try {
        await executeQueuedRun(env, runId);
      } catch (error) {
        const attempts = Number((message as { attempts?: number }).attempts ?? 1);
        const messageText = error instanceof Error ? error.message : String(error ?? "unknown");
        if (attempts >= RUN_MAX_ATTEMPTS) {
          const nowIso = new Date().toISOString();
          await markAgentRunRetryableFailure(env.DRECLAW_DB, runId, messageText, nowIso);
          await markAgentRunCompleted(env.DRECLAW_DB, runId, `Failed: ${messageText}`, nowIso);
          const run = await getAgentRun(env.DRECLAW_DB, runId);
          if (run && (await claimAgentRunDelivery(env.DRECLAW_DB, run.id, nowIso))) {
            await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, run.chatId, `Failed: ${messageText}`);
          }
          continue;
        }
        await markAgentRunRetryableFailure(env.DRECLAW_DB, runId, messageText, new Date().toISOString());
        const retry = (message as { retry?: () => void }).retry;
        if (typeof retry === "function") retry();
      }
    }
  },
} satisfies ExportedHandler<Env>;

async function handleTelegramWebhook(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
  const secret = request.headers.get("x-telegram-bot-api-secret-token");
  if (!secret || !timingSafeEqual(secret, env.TELEGRAM_WEBHOOK_SECRET)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    return new Response("Unsupported media type", { status: 415 });
  }

  const contentLengthHeader = request.headers.get("content-length");
  if (contentLengthHeader) {
    const contentLength = Number(contentLengthHeader);
    if (Number.isFinite(contentLength) && contentLength > WEBHOOK_MAX_BODY_BYTES) {
      return new Response("Payload too large", { status: 413 });
    }
  }

  const rawBody = await request.text();
  if (rawBody.length > WEBHOOK_MAX_BODY_BYTES) {
    return new Response("Payload too large", { status: 413 });
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const result = await processTelegramUpdate(
    {
      body,
      allowedUserId: env.TELEGRAM_ALLOWED_USER_ID,
    },
    {
      markUpdateSeen: (updateId) => markUpdateSeen(env.DRECLAW_DB, updateId),
      sendTyping: (chatId) => sendTelegramChatAction(env.TELEGRAM_BOT_TOKEN, chatId),
      runSession: async (sessionRequest) => {
        const commandText = (sessionRequest.message.text ?? sessionRequest.message.caption ?? "").trim().toLowerCase();
        if (commandText.startsWith("/cancel")) {
          const nowIso = new Date().toISOString();
          const count = await cancelActiveRunsForChat(
            env.DRECLAW_DB,
            sessionRequest.message.chat.id,
            nowIso,
          );
          await clearPendingChatInbox(env.DRECLAW_DB, sessionRequest.message.chat.id, nowIso);
          return {
            ok: true,
            text: count > 0 ? `Cancelled ${count} active run(s).` : "No active runs to cancel.",
          };
        }

        if (shouldEnqueueSessionRun(sessionRequest, env)) {
          return processQueuedPrompt(env, sessionRequest);
        }

        return runSessionViaDurableObject(env, sessionRequest);
      },
    },
  );

  if (result.status === "reply") {
    await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, result.reply.chatId, result.reply.text);
  }

  return new Response("ok");
}

function shouldEnqueueSessionRun(sessionRequest: SessionRequest, env: Env): boolean {
  if (!env.AGENT_RUN_QUEUE) return false;
  const text = (sessionRequest.message.text ?? sessionRequest.message.caption ?? "").trim();
  if (!text) return true;
  return !text.startsWith("/");
}

async function processQueuedPrompt(env: Env, sessionRequest: SessionRequest): Promise<{ ok: boolean; text: string; deferReply: boolean }> {
  const nowIso = new Date().toISOString();
  const chatId = sessionRequest.message.chat.id;
  const text = (sessionRequest.message.text ?? sessionRequest.message.caption ?? "").trim();

  const active = await getActiveAgentRunForChat(env.DRECLAW_DB, chatId);
  if (active) {
    await enqueueChatInboxMessage(env.DRECLAW_DB, {
      id: crypto.randomUUID(),
      chatId,
      updateId: sessionRequest.updateId,
      textJson: JSON.stringify({ text }),
      nowIso,
    });
    await env.AGENT_RUN_QUEUE?.send({ type: RUN_QUEUE_KIND, runId: active.id });
    return { ok: true, text: "", deferReply: true };
  }

  const runId = crypto.randomUUID();
  const created = await createAgentRun(env.DRECLAW_DB, {
    id: runId,
    updateId: sessionRequest.updateId,
    chatId,
    payloadJson: JSON.stringify({ sessionRequest } satisfies QueueRunEnvelope),
    nowIso,
  });
  if (!created) {
    return { ok: true, text: "", deferReply: true };
  }

  const inlineResult = await continueRunBurst(env, runId, {
    budgetMs: parsePositiveInt(env.INLINE_BURST_MS, DEFAULT_INLINE_BURST_MS),
    typingPulseMs: parsePositiveInt(env.TYPING_PULSE_MS, DEFAULT_TYPING_PULSE_MS),
    maxSlices: 1,
  });

  if (inlineResult.done) {
    return { ok: true, text: "", deferReply: true };
  }

  await env.AGENT_RUN_QUEUE?.send({ type: RUN_QUEUE_KIND, runId });
  return { ok: true, text: "", deferReply: true };
}

async function executeQueuedRun(env: Env, runId: string): Promise<void> {
  const result = await continueRunBurst(env, runId, {
    budgetMs: parsePositiveInt(env.QUEUE_BURST_MS, DEFAULT_QUEUE_BURST_MS),
    typingPulseMs: parsePositiveInt(env.TYPING_PULSE_MS, DEFAULT_TYPING_PULSE_MS),
    maxSlices: 4,
  });
  if (!result.done) {
    await env.AGENT_RUN_QUEUE?.send({ type: RUN_QUEUE_KIND, runId });
  }
}

async function continueRunBurst(
  env: Env,
  runId: string,
  options: { budgetMs: number; typingPulseMs: number; maxSlices: number },
): Promise<{ done: boolean }> {
  const start = Date.now();
  let lastTypingAt = 0;
  let slices = 0;
  while (Date.now() - start < options.budgetMs && slices < options.maxSlices) {
    slices += 1;
    const run = await getAgentRun(env.DRECLAW_DB, runId);
    if (!run) return { done: true };
    if (run.status === "completed" || run.status === "cancelled") return { done: true };

    const nowIso = new Date().toISOString();
    const marked = await markAgentRunRunning(env.DRECLAW_DB, runId, nowIso);
    if (!marked) return { done: false };

    if (Date.now() - lastTypingAt >= options.typingPulseMs) {
      await sendTelegramChatAction(env.TELEGRAM_BOT_TOKEN, run.chatId);
      lastTypingAt = Date.now();
    }

    const envelope = parseQueueEnvelope(run.payloadJson);
    const claimed = await claimChatInboxMessages(env.DRECLAW_DB, {
      chatId: run.chatId,
      runId,
      limit: INBOX_CLAIM_LIMIT,
      nowIso,
    });
    const pendingUserMessages = claimed
      .map((item: { textJson: string }) => safeJsonParse(item.textJson))
      .map((obj: Record<string, unknown>) => ({ updateId: Number(obj.updateId ?? 0), text: String(obj.text ?? "") }))
      .filter((item: { text: string }) => item.text.trim().length > 0);

    const sliceSteps = parsePositiveInt(env.RUN_SLICE_STEPS, 4);
    const step = await runSessionStepViaDurableObject(env, envelope, sliceSteps, pendingUserMessages);

    if (!step.done) {
      await updateAgentRunPayload(
        env.DRECLAW_DB,
        runId,
        JSON.stringify({ sessionRequest: envelope.sessionRequest, checkpoint: step.checkpoint } satisfies QueueRunEnvelope),
        new Date().toISOString(),
      );
      continue;
    }

    const completedAt = new Date().toISOString();
    const text = step.text || "Done.";
    await markAgentRunCompleted(env.DRECLAW_DB, runId, text, completedAt);
    const deliver = await claimAgentRunDelivery(env.DRECLAW_DB, runId, completedAt);
    if (deliver) {
      await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, run.chatId, text);
    }
    return { done: true };
  }
  return { done: false };
}

async function runSessionViaDurableObject(env: Env, sessionRequest: SessionRequest): Promise<{ ok: boolean; text: string }> {
  const id = env.SESSION_RUNTIME.idFromName(String(sessionRequest.message.chat.id));
  const stub = env.SESSION_RUNTIME.get(id);
  const response = await stub.fetch("https://session.local/run", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(sessionRequest),
  });
  return (await response.json()) as { ok: boolean; text: string };
}

async function runSessionStepViaDurableObject(
  env: Env,
  envelope: QueueRunEnvelope,
  sliceSteps: number,
  pendingUserMessages: Array<{ updateId: number; text: string }>,
): Promise<QueueRunStepResult> {
  const id = env.SESSION_RUNTIME.idFromName(String(envelope.sessionRequest.message.chat.id));
  const stub = env.SESSION_RUNTIME.get(id);
  const response = await stub.fetch("https://session.local/run-step", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sessionRequest: envelope.sessionRequest,
      checkpoint: envelope.checkpoint,
      sliceSteps,
      pendingUserMessages,
    }),
  });
  return (await response.json()) as QueueRunStepResult;
}

function parseQueueEnvelope(payloadJson: string): QueueRunEnvelope {
  const raw = JSON.parse(payloadJson) as { sessionRequest?: unknown; checkpoint?: unknown };
  if (!raw.sessionRequest || typeof raw.sessionRequest !== "object") {
    throw new Error("Invalid queued run payload");
  }
  const sessionRequest = raw.sessionRequest as SessionRequest;
  const checkpoint = raw.checkpoint && typeof raw.checkpoint === "object" ? (raw.checkpoint as QueueRunEnvelope["checkpoint"]) : undefined;
  return { sessionRequest, checkpoint };
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (!raw?.trim()) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.trunc(value);
}

function safeJsonParse(input: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(input) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function handleGoogleOAuthCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const state = String(url.searchParams.get("state") ?? "").trim();
  const code = String(url.searchParams.get("code") ?? "").trim();
  if (!state || !code) {
    return htmlResponse(400, "Google OAuth failed", "Missing state or code.");
  }

  const oauthState = await getGoogleOAuthState(env.DRECLAW_DB, state);
  if (!oauthState) {
    return htmlResponse(400, "Google OAuth failed", "Invalid or expired state.");
  }
  if (oauthState.usedAt) {
    return htmlResponse(400, "Google OAuth failed", "This authorization link was already used.");
  }
  if (Date.parse(oauthState.expiresAt) <= Date.now()) {
    return htmlResponse(400, "Google OAuth failed", "Authorization link expired. Run /google connect again.");
  }

  const markedUsed = await markGoogleOAuthStateUsed(env.DRECLAW_DB, state, new Date().toISOString());
  if (!markedUsed) {
    return htmlResponse(400, "Google OAuth failed", "Authorization link is no longer valid.");
  }

  try {
    const oauthConfig = getGoogleOAuthConfig(env);
    const exchange = await exchangeGoogleOAuthCode(oauthConfig, code);
    const refreshToken = exchange.refreshToken;
    if (!refreshToken) {
      throw new Error("Google did not return a refresh token. Revoke app access and retry /google connect.");
    }

    const key = decodeEncryptionKey(String(env.GOOGLE_OAUTH_ENCRYPTION_KEY ?? ""));
    const encrypted = await encryptSecret(refreshToken, key);
    await upsertGoogleOAuthToken(env.DRECLAW_DB, {
      principal: GOOGLE_OAUTH_DEFAULT_PRINCIPAL,
      telegramUserId: oauthState.telegramUserId,
      refreshTokenCiphertext: encrypted.ciphertext,
      nonce: encrypted.nonce,
      scopes: exchange.scope,
      updatedAt: new Date().toISOString(),
    });

    try {
      await sendTelegramMessage(
        env.TELEGRAM_BOT_TOKEN,
        oauthState.chatId,
        "Google account linked successfully. You can now use Google features.",
      );
    } catch (error) {
      console.warn("google-oauth-telegram-notify-failed", {
        chatId: oauthState.chatId,
        error: error instanceof Error ? error.message : String(error ?? "unknown"),
      });
    }

    return htmlResponse(200, "Google OAuth complete", "You can close this tab and return to Telegram.");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown OAuth error";
    return htmlResponse(400, "Google OAuth failed", message);
  }
}

function htmlResponse(status: number, title: string, message: string): Response {
  const body = `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title></head><body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p></body></html>`;
  return new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function timingSafeEqual(left: string, right: string): boolean {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const maxLength = Math.max(leftBytes.length, rightBytes.length);

  let diff = leftBytes.length ^ rightBytes.length;
  for (let index = 0; index < maxLength; index += 1) {
    const leftByte = index < leftBytes.length ? leftBytes[index] : 0;
    const rightByte = index < rightBytes.length ? rightBytes[index] : 0;
    diff |= leftByte ^ rightByte;
  }

  return diff === 0;
}
