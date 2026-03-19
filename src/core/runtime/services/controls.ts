import type { RuntimeDeps } from "../../app/types";
import { clearAllVfsEntries } from "../../vfs/repo";
import { getPersistedThreadControls } from "../../loop/repo";
import { createRunCoordinator, idleRunStatus } from "../../loop/run";
import type { BotThreadState } from "../../loop/state";
import { normalizeBotThreadState } from "../../loop/state";
import { getRuntimeConfig } from "../policy/model";
import { getRuntimeAlias, listRuntimeAliases } from "../policy/model";
import type { MemoryGateway } from "../adapters/memory";

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
        `cancel_requested: ${run.runStatus.cancelRequested ? "yes" : "no"}`,
        `stopped: ${run.runStatus.stoppedAt ? "yes" : "no"}`,
        `workflow_id: ${run.workflowInstanceId ?? run.runStatus.workflowInstanceId ?? "-"}`,
        `running_for: ${run.runningFor}`,
        `last_heartbeat: ${run.lastHeartbeat}`,
        `verbose: ${(controls?.verbose ?? state.verbose) ? "on" : "off"}`,
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
        "/reset - clear conversation context",
        "/factory-reset - clear conversation, memory, and VFS",
        "/stop - cooperatively stop the current run",
        "/verbose on|off - show tool traces",
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
      await clearAllVfsEntries(params.runtimeDeps.DRECLAW_DB, new Date().toISOString());
      return normalizeBotThreadState(undefined);
    },

    setVerbose(state, enabled) {
      return { ...state, verbose: enabled };
    },
  };
}
