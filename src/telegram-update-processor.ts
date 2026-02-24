import { parseUpdate } from "./telegram";
import type { SessionRequest, SessionResponse } from "./types";

export interface TelegramProcessorDeps {
  markUpdateSeen(updateId: number): Promise<boolean>;
  sendTyping?(chatId: number): Promise<void>;
  runSession(request: SessionRequest): Promise<SessionResponse>;
}

export interface TelegramProcessorInput {
  body: unknown;
  allowedUserId: string;
}

export type TelegramProcessorResult =
  | { status: "ignored"; reason: string }
  | { status: "reply"; reply: { chatId: number; text: string } };

export async function processTelegramUpdate(
  input: TelegramProcessorInput,
  deps: TelegramProcessorDeps,
): Promise<TelegramProcessorResult> {
  const update = parseUpdate(input.body);
  if (!update) return { status: "ignored", reason: "invalid_update" };

  const unseen = await deps.markUpdateSeen(update.update_id);
  if (!unseen) return { status: "ignored", reason: "duplicate_update" };
  if (!update.message) return { status: "ignored", reason: "missing_message" };

  const message = update.message;
  if (message.chat.type !== "private") return { status: "ignored", reason: "non_private_chat" };
  if (!message.from || String(message.from.id) !== input.allowedUserId) {
    return { status: "ignored", reason: "unauthorized_user" };
  }

  const response = await runSessionWithTypingHeartbeat(message.chat.id, {
    sendTyping: deps.sendTyping,
    runSession: () =>
      deps.runSession({
        updateId: update.update_id,
        message,
      }),
  });

  return {
    status: "reply",
    reply: {
      chatId: message.chat.id,
      text: response.text || "Done.",
    },
  };
}

async function runSessionWithTypingHeartbeat(
  chatId: number,
  params: {
    sendTyping?: (chatId: number) => Promise<void>;
    runSession: () => Promise<SessionResponse>;
  },
): Promise<SessionResponse> {
  const sendTyping = params.sendTyping;
  if (!sendTyping) {
    return params.runSession();
  }

  let active = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const intervalMs = 4000;

  const pulse = async (): Promise<void> => {
    if (!active) return;
    try {
      await sendTyping(chatId);
    } catch (error) {
      console.warn("telegram-typing-indicator-failed", {
        chatId,
        error: error instanceof Error ? error.message : String(error ?? "unknown"),
      });
    } finally {
      if (active) {
        timer = setTimeout(() => {
          void pulse();
        }, intervalMs);
      }
    }
  };

  void pulse();
  try {
    return await params.runSession();
  } finally {
    active = false;
    if (timer) {
      clearTimeout(timer);
    }
  }
}
