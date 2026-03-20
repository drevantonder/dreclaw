import { normalizeCodeRuntimeState, type CodeRuntimeState } from "../tools/code-exec";

export const THREAD_CONTROL_DEFAULTS = {
  verbose: false,
  thinking: true,
  reasoning: false,
} as const;

export type ConversationEntry = {
  role: "user" | "assistant" | "tool";
  content: string;
};

export interface RunStatus {
  running: boolean;
  startedAt: string | null;
  lastHeartbeatAt: string | null;
  cancelRequested: boolean;
  cancelRequestedAt: string | null;
  stoppedAt: string | null;
  workflowInstanceId: string | null;
}

export interface BotThreadState {
  history: ConversationEntry[];
  memoryTurns: number;
  verbose: boolean;
  thinking: boolean;
  reasoning: boolean;
  modelAlias: string | null;
  codeRuntime: CodeRuntimeState;
  loadedSkills: string[];
  runStatus: RunStatus;
}

export function normalizeBotThreadState(input: BotThreadState | null | undefined): BotThreadState {
  const source = input ?? undefined;
  return {
    history: Array.isArray(source?.history)
      ? source.history
          .filter((entry) => entry && typeof entry === "object")
          .map(
            (entry): ConversationEntry => ({
              role: entry.role === "assistant" || entry.role === "tool" ? entry.role : "user",
              content: typeof entry.content === "string" ? entry.content : "",
            }),
          )
          .filter((entry) => entry.content.trim())
          .slice(-24)
      : [],
    memoryTurns: Number.isFinite(source?.memoryTurns)
      ? Math.max(0, Math.trunc(source?.memoryTurns ?? 0))
      : 0,
    verbose:
      source?.verbose === undefined ? THREAD_CONTROL_DEFAULTS.verbose : Boolean(source?.verbose),
    thinking:
      source?.thinking === undefined ? THREAD_CONTROL_DEFAULTS.thinking : Boolean(source?.thinking),
    reasoning:
      source?.reasoning === undefined
        ? THREAD_CONTROL_DEFAULTS.reasoning
        : Boolean(source?.reasoning),
    modelAlias:
      typeof source?.modelAlias === "string" && source.modelAlias.trim()
        ? source.modelAlias.trim().toLowerCase()
        : null,
    codeRuntime: normalizeCodeRuntimeState(source?.codeRuntime),
    loadedSkills: Array.isArray(source?.loadedSkills)
      ? source.loadedSkills
          .filter((skill): skill is string => typeof skill === "string" && skill.trim().length > 0)
          .slice(-12)
      : [],
    runStatus: {
      running: Boolean(source?.runStatus?.running),
      startedAt:
        typeof source?.runStatus?.startedAt === "string" && source.runStatus.startedAt.trim()
          ? source.runStatus.startedAt
          : null,
      lastHeartbeatAt:
        typeof source?.runStatus?.lastHeartbeatAt === "string" &&
        source.runStatus.lastHeartbeatAt.trim()
          ? source.runStatus.lastHeartbeatAt
          : null,
      cancelRequested: Boolean(source?.runStatus?.cancelRequested),
      cancelRequestedAt:
        typeof source?.runStatus?.cancelRequestedAt === "string" &&
        source.runStatus.cancelRequestedAt.trim()
          ? source.runStatus.cancelRequestedAt
          : null,
      stoppedAt:
        typeof source?.runStatus?.stoppedAt === "string" && source.runStatus.stoppedAt.trim()
          ? source.runStatus.stoppedAt
          : null,
      workflowInstanceId:
        typeof source?.runStatus?.workflowInstanceId === "string" &&
        source.runStatus.workflowInstanceId.trim()
          ? source.runStatus.workflowInstanceId
          : null,
    },
  };
}

export function pushHistory(
  state: BotThreadState,
  role: ConversationEntry["role"],
  content: string,
): BotThreadState {
  const text = String(content ?? "").trim();
  if (!text) return state;
  return {
    ...state,
    history: [...state.history, { role, content: text }].slice(-24),
  };
}
