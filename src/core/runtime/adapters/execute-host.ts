import type { ExecuteHostBinding } from "../../tools/code-exec";

export type ExecuteHostBindingFactory = (params: {
  threadId: string;
  chatId: number;
}) => ExecuteHostBinding | null;

export function createExecuteHostBindingFactory(params: {
  executionContext?: ExecutionContext & {
    exports?: Record<string, (options?: { props?: unknown }) => ExecuteHostBinding>;
  };
  getCodeExecutionConfig: () => {
    limits: {
      execMaxOutputBytes: number;
      execMaxLogLines: number;
      netRequestTimeoutMs: number;
      netMaxResponseBytes: number;
      vfsMaxFileBytes: number;
      vfsListLimit: number;
    };
  };
}): ExecuteHostBindingFactory {
  return ({ threadId, chatId }) => {
    const factory = params.executionContext?.exports?.ExecuteHost;
    if (typeof factory !== "function") return null;
    const config = params.getCodeExecutionConfig();
    return factory({
      props: {
        threadId,
        chatId,
        limits: {
          execMaxOutputBytes: config.limits.execMaxOutputBytes,
          execMaxLogLines: config.limits.execMaxLogLines,
          netRequestTimeoutMs: config.limits.netRequestTimeoutMs,
          netMaxResponseBytes: config.limits.netMaxResponseBytes,
          vfsMaxFileBytes: config.limits.vfsMaxFileBytes,
          vfsListLimit: config.limits.vfsListLimit,
        },
        allowedGoogleServices: ["gmail", "drive", "sheets", "docs", "calendar"],
      },
    });
  };
}
