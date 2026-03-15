import type { Env } from "../cloudflare/env";
import type { RuntimeDeps } from "../core/app/types";
import { BotRuntime } from "../core/loop/runtime";
import { createPluginRegistry } from "../core/plugins/registry";
import { createGooglePlugin } from "../plugins/google";
import type { GooglePluginDeps } from "../plugins/google/types";
import { createRemindersPlugin } from "../plugins/reminders";
import type { RemindersPluginDeps } from "../plugins/reminders";
import type { CommandDeps } from "../core/commands";

const runtimeDepsCache = new WeakMap<Env, RuntimeDeps>();

export function buildGooglePluginDeps(env: Env): GooglePluginDeps {
  return {
    db: env.DRECLAW_DB,
    settings: {
      clientId: env.GOOGLE_OAUTH_CLIENT_ID,
      clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET,
      redirectUri: env.GOOGLE_OAUTH_REDIRECT_URI,
      scopes: env.GOOGLE_OAUTH_SCOPES,
      encryptionKey: env.GOOGLE_OAUTH_ENCRYPTION_KEY,
    },
  };
}

export function buildRemindersPluginDeps(env: Env): RemindersPluginDeps {
  return {
    db: env.DRECLAW_DB,
    timezone: env.USER_TIMEZONE,
    wakeWorkflow: env.REMINDERS_WAKE_WORKFLOW,
  };
}

export function buildRuntimeDeps(env: Env): RuntimeDeps {
  const cached = runtimeDepsCache.get(env);
  if (cached) return cached;
  const pluginRegistry = createPluginRegistry([
    createGooglePlugin(buildGooglePluginDeps(env)),
    createRemindersPlugin(buildRemindersPluginDeps(env)),
  ]);
  const deps: RuntimeDeps = {
    DRECLAW_DB: env.DRECLAW_DB,
    TELEGRAM_BOT_TOKEN: env.TELEGRAM_BOT_TOKEN,
    CONVERSATION_WORKFLOW: env.CONVERSATION_WORKFLOW,
    USER_TIMEZONE: env.USER_TIMEZONE,
    AI_PROVIDER: env.AI_PROVIDER,
    MODEL: env.MODEL,
    BASE_URL: env.BASE_URL,
    OPENCODE_API_KEY: env.OPENCODE_API_KEY,
    AI: env.AI,
    LOADER: env.LOADER,
    REASONING_EFFORT: env.REASONING_EFFORT,
    CODE_EXEC_ENABLED: env.CODE_EXEC_ENABLED,
    NET_FETCH_ENABLED: env.NET_FETCH_ENABLED,
    PKG_INSTALL_ENABLED: env.PKG_INSTALL_ENABLED,
    EXEC_TIMEOUT_MS: env.EXEC_TIMEOUT_MS,
    EXEC_MEMORY_MB: env.EXEC_MEMORY_MB,
    EXEC_STACK_KB: env.EXEC_STACK_KB,
    EXEC_MAX_HOST_CALLS: env.EXEC_MAX_HOST_CALLS,
    EXEC_MAX_LOG_LINES: env.EXEC_MAX_LOG_LINES,
    EXEC_MAX_OUTPUT_BYTES: env.EXEC_MAX_OUTPUT_BYTES,
    NET_MAX_REQUESTS_PER_RUN: env.NET_MAX_REQUESTS_PER_RUN,
    NET_MAX_PARALLEL: env.NET_MAX_PARALLEL,
    NET_REQUEST_TIMEOUT_MS: env.NET_REQUEST_TIMEOUT_MS,
    NET_MAX_RESPONSE_BYTES: env.NET_MAX_RESPONSE_BYTES,
    NET_MAX_TOTAL_DOWNLOAD_BYTES: env.NET_MAX_TOTAL_DOWNLOAD_BYTES,
    NET_MAX_REDIRECTS: env.NET_MAX_REDIRECTS,
    PKG_INSTALL_TIMEOUT_MS: env.PKG_INSTALL_TIMEOUT_MS,
    PKG_MAX_SPEC_LENGTH: env.PKG_MAX_SPEC_LENGTH,
    PKG_MAX_MODULE_BYTES: env.PKG_MAX_MODULE_BYTES,
    PKG_MAX_TOTAL_INSTALL_BYTES_PER_RUN: env.PKG_MAX_TOTAL_INSTALL_BYTES_PER_RUN,
    PKG_MAX_INSTALLS_PER_RUN: env.PKG_MAX_INSTALLS_PER_RUN,
    VFS_MAX_FILE_BYTES: env.VFS_MAX_FILE_BYTES,
    VFS_MAX_FILES: env.VFS_MAX_FILES,
    VFS_MAX_PATH_LENGTH: env.VFS_MAX_PATH_LENGTH,
    VFS_LIST_LIMIT: env.VFS_LIST_LIMIT,
    MEMORY_ENABLED: env.MEMORY_ENABLED,
    MEMORY_RETENTION_DAYS: env.MEMORY_RETENTION_DAYS,
    MEMORY_MAX_INJECT_TOKENS: env.MEMORY_MAX_INJECT_TOKENS,
    MEMORY_REFLECTION_EVERY_TURNS: env.MEMORY_REFLECTION_EVERY_TURNS,
    MEMORY_EMBEDDING_MODEL: env.MEMORY_EMBEDDING_MODEL,
    VECTORIZE_MEMORY: env.VECTORIZE_MEMORY,
    RUN_SLICE_STEPS: env.RUN_SLICE_STEPS,
    INLINE_BURST_MS: env.INLINE_BURST_MS,
    QUEUE_BURST_MS: env.QUEUE_BURST_MS,
    TYPING_PULSE_MS: env.TYPING_PULSE_MS,
    PROFILING_ENABLED: env.PROFILING_ENABLED,
    PROFILING_SAMPLE_RATE: env.PROFILING_SAMPLE_RATE,
    pluginRegistry,
  };
  runtimeDepsCache.set(env, deps);
  return deps;
}

export function buildCommandDeps(env: Env, executionContext?: ExecutionContext): CommandDeps {
  const runtimeDeps = buildRuntimeDeps(env);
  return {
    runtimeDeps,
    runtime: new BotRuntime(runtimeDeps, executionContext as never),
    pluginRegistry: runtimeDeps.pluginRegistry,
  };
}
