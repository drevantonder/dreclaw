export interface CodeRuntimeState {
  readonly version?: number;
}

export interface CodeExecutionLimits {
  execTimeoutMs: number;
  execMaxLogLines: number;
  execMaxOutputBytes: number;
  netRequestTimeoutMs: number;
  netMaxResponseBytes: number;
  netMaxRedirects: number;
  vfsMaxFileBytes: number;
  vfsMaxFiles: number;
  vfsMaxPathLength: number;
  vfsListLimit: number;
}

export interface CodeExecutionConfig {
  codeExecEnabled: boolean;
  netFetchEnabled: boolean;
  limits: CodeExecutionLimits;
}

const DEFAULT_LIMITS: CodeExecutionLimits = {
  execTimeoutMs: 4_000,
  execMaxLogLines: 120,
  execMaxOutputBytes: 65_536,
  netRequestTimeoutMs: 10_000,
  netMaxResponseBytes: 2_097_152,
  netMaxRedirects: 5,
  vfsMaxFileBytes: 524_288,
  vfsMaxFiles: 2_000,
  vfsMaxPathLength: 240,
  vfsListLimit: 500,
};

export function normalizeCodeRuntimeState(_state: CodeRuntimeState | undefined): CodeRuntimeState {
  return {};
}

export function getCodeExecutionConfig(
  env: Record<string, string | undefined>,
): CodeExecutionConfig {
  return {
    codeExecEnabled: parseFlag(env.CODE_EXEC_ENABLED, true),
    netFetchEnabled: parseFlag(env.NET_FETCH_ENABLED, true),
    limits: {
      execTimeoutMs: parsePositiveInt(env.EXEC_TIMEOUT_MS, DEFAULT_LIMITS.execTimeoutMs),
      execMaxLogLines: parsePositiveInt(env.EXEC_MAX_LOG_LINES, DEFAULT_LIMITS.execMaxLogLines),
      execMaxOutputBytes: parsePositiveInt(
        env.EXEC_MAX_OUTPUT_BYTES,
        DEFAULT_LIMITS.execMaxOutputBytes,
      ),
      netRequestTimeoutMs: parsePositiveInt(
        env.NET_REQUEST_TIMEOUT_MS,
        DEFAULT_LIMITS.netRequestTimeoutMs,
      ),
      netMaxResponseBytes: parsePositiveInt(
        env.NET_MAX_RESPONSE_BYTES,
        DEFAULT_LIMITS.netMaxResponseBytes,
      ),
      netMaxRedirects: parsePositiveInt(env.NET_MAX_REDIRECTS, DEFAULT_LIMITS.netMaxRedirects),
      vfsMaxFileBytes: parsePositiveInt(env.VFS_MAX_FILE_BYTES, DEFAULT_LIMITS.vfsMaxFileBytes),
      vfsMaxFiles: parsePositiveInt(env.VFS_MAX_FILES, DEFAULT_LIMITS.vfsMaxFiles),
      vfsMaxPathLength: parsePositiveInt(env.VFS_MAX_PATH_LENGTH, DEFAULT_LIMITS.vfsMaxPathLength),
      vfsListLimit: parsePositiveInt(env.VFS_LIST_LIMIT, DEFAULT_LIMITS.vfsListLimit),
    },
  };
}

function parseFlag(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value === "") return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (value == null || value === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
