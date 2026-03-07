import { normalizeCodeRuntimeState, type CodeRuntimeState } from "../code-exec";

export type ConversationEntry = {
  role: "user" | "assistant" | "tool";
  content: string;
};

export interface BotThreadState {
  history: ConversationEntry[];
  memoryTurns: number;
  verbose: boolean;
  codeRuntime: CodeRuntimeState;
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
