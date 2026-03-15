import type {
  ConversationWorkflowPayload,
  ReminderWakeWorkflowPayload,
} from "../core/loop/workflow";

export type { ConversationWorkflowPayload, ReminderWakeWorkflowPayload };

export interface Env {
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  TELEGRAM_BOT_USERNAME?: string;
  TELEGRAM_ALLOWED_USER_ID: string;
  USER_TIMEZONE?: string;
  AI_PROVIDER?: string;
  MODEL: string;
  BASE_URL?: string;
  OPENCODE_API_KEY?: string;
  GOOGLE_OAUTH_CLIENT_ID?: string;
  GOOGLE_OAUTH_CLIENT_SECRET?: string;
  GOOGLE_OAUTH_REDIRECT_URI?: string;
  GOOGLE_OAUTH_SCOPES?: string;
  GOOGLE_OAUTH_ENCRYPTION_KEY?: string;
  AI?: Ai;
  VECTORIZE_MEMORY?: VectorizeIndex;
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
  VFS_MAX_FILE_BYTES?: string;
  VFS_MAX_FILES?: string;
  VFS_MAX_PATH_LENGTH?: string;
  VFS_LIST_LIMIT?: string;
  MEMORY_ENABLED?: string;
  MEMORY_RETENTION_DAYS?: string;
  MEMORY_MAX_INJECT_TOKENS?: string;
  MEMORY_REFLECTION_EVERY_TURNS?: string;
  MEMORY_EMBEDDING_MODEL?: string;
  RUN_SLICE_STEPS?: string;
  INLINE_BURST_MS?: string;
  QUEUE_BURST_MS?: string;
  TYPING_PULSE_MS?: string;
  REASONING_EFFORT?: string;
  DRECLAW_DB: D1Database;
  CONVERSATION_WORKFLOW?: Workflow<ConversationWorkflowPayload>;
  REMINDERS_WAKE_WORKFLOW?: Workflow<ReminderWakeWorkflowPayload>;
  LOADER?: {
    get(
      id: string,
      getCode: () => Promise<unknown>,
    ): {
      getEntrypoint(
        name?: string,
        options?: { props?: unknown },
      ): {
        fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
      };
    };
  };
}
