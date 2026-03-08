import { normalizeCodeRuntimeState, type CodeRuntimeState } from "../code-exec";

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
}

export interface BotThreadState {
  history: ConversationEntry[];
  memoryTurns: number;
  verbose: boolean;
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
          .map((entry): ConversationEntry => ({
            role: entry.role === "assistant" || entry.role === "tool" ? entry.role : "user",
            content: typeof entry.content === "string" ? entry.content : "",
          }))
          .filter((entry) => entry.content.trim())
          .slice(-24)
      : [],
    memoryTurns: Number.isFinite(source?.memoryTurns) ? Math.max(0, Math.trunc(source?.memoryTurns ?? 0)) : 0,
    verbose: Boolean(source?.verbose),
    codeRuntime: normalizeCodeRuntimeState(source?.codeRuntime),
    loadedSkills: Array.isArray(source?.loadedSkills)
      ? source.loadedSkills.filter((skill): skill is string => typeof skill === "string" && skill.trim().length > 0).slice(-12)
      : [],
    runStatus: {
      running: Boolean(source?.runStatus?.running),
      startedAt: typeof source?.runStatus?.startedAt === "string" && source.runStatus.startedAt.trim() ? source.runStatus.startedAt : null,
      lastHeartbeatAt:
        typeof source?.runStatus?.lastHeartbeatAt === "string" && source.runStatus.lastHeartbeatAt.trim()
          ? source.runStatus.lastHeartbeatAt
          : null,
      cancelRequested: Boolean(source?.runStatus?.cancelRequested),
      cancelRequestedAt:
        typeof source?.runStatus?.cancelRequestedAt === "string" && source.runStatus.cancelRequestedAt.trim()
          ? source.runStatus.cancelRequestedAt
          : null,
    },
  };
}

export function pushHistory(state: BotThreadState, role: ConversationEntry["role"], content: string): BotThreadState {
  const text = String(content ?? "").trim();
  if (!text) return state;
  return {
    ...state,
    history: [...state.history, { role, content: text }].slice(-24),
  };
}
