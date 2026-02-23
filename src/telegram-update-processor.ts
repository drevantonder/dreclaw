import { parseUpdate } from "./telegram";
import type { SessionRequest, SessionResponse } from "./types";

export interface TelegramProcessorDeps {
  markUpdateSeen(updateId: number): Promise<boolean>;
  sendTyping?(chatId: number): Promise<void>;
  sendProgressMessage?(chatId: number, text: string): Promise<number | null>;
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

  if (deps.sendTyping) {
    try {
      await deps.sendTyping(message.chat.id);
    } catch (error) {
      console.warn("telegram-typing-indicator-failed", {
        chatId: message.chat.id,
        error: error instanceof Error ? error.message : String(error ?? "unknown"),
      });
    }
  }

  const text = (message.text ?? message.caption ?? "").trim();
  let progressMessageId: number | undefined;
  if (deps.sendProgressMessage && shouldUseProgressBubble(text)) {
    try {
      const progressId = await deps.sendProgressMessage(message.chat.id, "Working...");
      if (typeof progressId === "number") {
        progressMessageId = progressId;
      }
    } catch (error) {
      console.warn("telegram-progress-bubble-failed", {
        chatId: message.chat.id,
        error: error instanceof Error ? error.message : String(error ?? "unknown"),
      });
    }
  }

  const response = await deps.runSession({
    updateId: update.update_id,
    message,
    progressMessageId,
  });

  return {
    status: "reply",
    reply: {
      chatId: message.chat.id,
      text: response.text || "Done.",
    },
  };
}

function shouldUseProgressBubble(text: string): boolean {
  if (!text) return true;
  if (!text.startsWith("/")) return true;
  const command = text.split(/\s+/, 1)[0].toLowerCase();
  return command !== "/status" && command !== "/reset" && command !== "/details" && command !== "/thinking";
}
