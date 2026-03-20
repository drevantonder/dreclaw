import type { RuntimeDeps } from "../../app/types";
import { getPersistedThreadControls } from "../../loop/repo";
import { createRunCoordinator, idleRunStatus } from "../../loop/run";
import type { BotThreadState } from "../../loop/state";
import { normalizeBotThreadState } from "../../loop/state";
import { getRuntimeConfig } from "../policy/model";
import { getRuntimeAlias, listRuntimeAliases } from "../policy/model";
import type { MemoryGateway } from "../adapters/memory";
import type { WorkspaceGateway } from "../adapters/workspace";

export interface RuntimeControlsService {
  status(threadId: string, state: BotThreadState): Promise<string>;
  help(): string;
  reset(state: BotThreadState): BotThreadState;
  factoryReset(chatId: number): Promise<BotThreadState>;
  setVerbose(state: BotThreadState, enabled: boolean): BotThreadState;
}

export function createRuntimeControlsService(params: {
  runtimeDeps: RuntimeDeps;
  runs: ReturnType<typeof createRunCoordinator>;
  memoryGateway: MemoryGateway;
  workspaceGateway: WorkspaceGateway;
  googlePlugin?: { isLinked?: () => Promise<boolean> } | null;
}): RuntimeControlsService {
  return {
    async status(threadId, state) {
      const runtime = getRuntimeConfig(params.runtimeDeps, state);
      const memory = params.memoryGateway.getConfigSafe();
      const googleLinked = Boolean(await params.googlePlugin?.isLinked?.());
      const controls = await getPersistedThreadControls(params.runtimeDeps.DRECLAW_DB, threadId);
      const run = await params.runs.getStatus(threadId, state);
      return [
        `alias: ${getRuntimeAlias(state)}`,
        `model: ${runtime.model}`,
        `provider: ${runtime.provider}`,
        `memory: ${memory.enabled ? "on" : "off"}`,
        `google: ${googleLinked ? "linked" : "not linked"}`,
        `busy: ${run.busy}`,
        `verbose: ${(controls?.verbose ?? state.verbose) ? "on" : "off"}`,
        `thinking: ${(controls?.thinking ?? state.thinking) ? "on" : "off"}`,
        `reasoning: ${(controls?.reasoning ?? state.reasoning) ? "on" : "off"}`,
        `history: ${state.history.length}`,
        `thread: ${threadId}`,
      ].join("\n");
    },

    help() {
      return [
        "Commands:",
        "/help - show commands",
        "/status - show current bot status",
        "/model - show current model and aliases",
        "/model <alias> - switch model for this chat",
        "/new - start a fresh session and keep settings",
        "/reset - clear conversation context and restore chat defaults",
        "/factory-reset - clear conversation, memory, and workspace files",
        "/stop - cooperatively stop the current run",
        "/verbose on|off - show tool traces",
        "/thinking on|off - control model thinking effort",
        "/reasoning on|off - show visible reasoning text",
        "/google connect - link your Google account",
        "/google status - show Google link status",
        "/google disconnect - unlink your Google account",
        `models: ${listRuntimeAliases().join(", ")}`,
      ].join("\n");
    },

    reset(state) {
      const normalized = normalizeBotThreadState(state);
      return {
        ...normalized,
        history: [],
        runStatus: idleRunStatus(),
      };
    },

    async factoryReset(chatId) {
      await params.memoryGateway.factoryReset({ chatId });
      await params.workspaceGateway.factoryReset();
      return normalizeBotThreadState(undefined);
    },

    setVerbose(state, enabled) {
      return { ...state, verbose: enabled };
    },
  };
}
