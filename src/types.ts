export const DEFAULT_BASE_URL = "https://opencode.ai/zen/v1";

export interface Env {
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  TELEGRAM_ALLOWED_USER_ID: string;
  MODEL: string;
  BASE_URL?: string;
  OPENCODE_ZEN_API_KEY?: string;
  DRECLAW_DB: D1Database;
  SESSION_RUNTIME: DurableObjectNamespace;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

export interface TelegramMessage {
  message_id: number;
  date: number;
  text?: string;
  caption?: string;
  from?: { id: number };
  chat: { id: number; type: string };
  photo?: Array<{ file_id: string; file_size?: number }>;
}

export interface SessionRequest {
  updateId: number;
  message: TelegramMessage;
}

export type ProgressMode = "compact" | "debug";

export interface SessionResponse {
  ok: boolean;
  text: string;
}
