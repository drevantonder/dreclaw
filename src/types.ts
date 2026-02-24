export const DEFAULT_BASE_URL = "https://opencode.ai/zen/v1";

export interface Env {
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  TELEGRAM_ALLOWED_USER_ID: string;
  MODEL: string;
  BASE_URL?: string;
  OPENCODE_ZEN_API_KEY?: string;
  CODE_EXEC_ENABLED?: string;
  NET_FETCH_ENABLED?: string;
  PKG_INSTALL_ENABLED?: string;
  EXEC_TIMEOUT_MS?: string;
  EXEC_MEMORY_MB?: string;
  EXEC_STACK_KB?: string;
  EXEC_MAX_HOST_CALLS?: string;
  EXEC_MAX_LOG_LINES?: string;
  EXEC_MAX_OUTPUT_BYTES?: string;
  NET_MAX_REQUESTS_PER_RUN?: string;
  NET_MAX_PARALLEL?: string;
  NET_REQUEST_TIMEOUT_MS?: string;
  NET_MAX_RESPONSE_BYTES?: string;
  NET_MAX_TOTAL_DOWNLOAD_BYTES?: string;
  NET_MAX_REDIRECTS?: string;
  PKG_INSTALL_TIMEOUT_MS?: string;
  PKG_MAX_SPEC_LENGTH?: string;
  PKG_MAX_MODULE_BYTES?: string;
  PKG_MAX_TOTAL_INSTALL_BYTES_PER_RUN?: string;
  PKG_MAX_INSTALLS_PER_RUN?: string;
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
