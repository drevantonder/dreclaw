export const OPENCODE_ZEN_BASE_URL = "https://opencode.ai/zen/v1";
export const OPENCODE_GO_BASE_URL = "https://opencode.ai/zen/go/v1";
export const DEFAULT_BASE_URL = OPENCODE_ZEN_BASE_URL;

export type { Env, ConversationWorkflowPayload } from "./cloudflare/env";
export type {
  SessionRequest,
  TelegramMessage,
  TelegramUpdate,
} from "./chat-adapters/telegram/types";
