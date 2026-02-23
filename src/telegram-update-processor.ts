import { parseUpdate } from "./telegram";
import type { SessionRequest, SessionResponse, TelegramMessage } from "./types";

export interface TelegramProcessorDeps {
  markUpdateSeen(updateId: number): Promise<boolean>;
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

  const response = await deps.runSession({
    updateId: update.update_id,
    message,
  });

  return {
    status: "reply",
    reply: {
      chatId: message.chat.id,
      text: response.text || "Done.",
    },
  };
}

export function buildSessionRequest(updateId: number, message: TelegramMessage): SessionRequest {
  return { updateId, message };
}
