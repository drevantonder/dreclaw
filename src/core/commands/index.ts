import type { CommandContext, CommandResult, RuntimeDeps } from "../app/types";
import { getRemindersPlugin } from "../../plugins/reminders";
import type { PluginRegistry } from "../plugins/types";
import {
  getPersistedThreadControls,
  getThreadStateSnapshot,
  setPersistedThreadControls,
  setThreadStateSnapshot,
} from "../loop/repo";
import {
  normalizeBotThreadState,
  THREAD_CONTROL_DEFAULTS,
  type BotThreadState,
} from "../loop/state";
import { createRunCoordinator } from "../loop/run";
import type { RuntimeControlsService } from "../runtime";
import {
  findModelCatalogEntry,
  getRuntimeAlias,
  getRuntimeConfig,
  listRuntimeAliases,
} from "../runtime/policy/model";

export interface CommandDeps {
  runtimeDeps: RuntimeDeps;
  controls: RuntimeControlsService;
  pluginRegistry: PluginRegistry;
}

export async function maybeHandleAsyncCoreCommand(
  deps: CommandDeps,
  input: CommandContext,
): Promise<CommandResult | null> {
  const text = input.text.trim();
  if (!text.startsWith("/")) return null;
  return handleAsyncCommand({
    deps,
    input: { ...input, text },
  });
}

export async function handleAsyncCommand(params: {
  deps: CommandDeps;
  input: CommandContext;
}): Promise<CommandResult> {
  const { deps, input } = params;
  const { runtimeDeps, controls, pluginRegistry } = deps;
  const { threadId, channelId, text } = input;
  await getRemindersPlugin(pluginRegistry.getByName("reminders")).ensureReminderProfile({
    primaryChatId: channelId,
  });
  const [command, value] = text.split(/\s+/, 2);
  const lowered = command.toLowerCase();
  const runs = createRunCoordinator({
    db: runtimeDeps.DRECLAW_DB,
    workflow: runtimeDeps.CONVERSATION_WORKFLOW,
  });
  const snapshot = normalizeBotThreadState(
    await getThreadStateSnapshot<BotThreadState>(runtimeDeps.DRECLAW_DB, threadId),
  );
  const controlledState = await runs.recoverState(threadId, snapshot);
  const status = await runs.getStatus(threadId, controlledState);
  const busy = status.busy === "yes";

  if (lowered === "/help") return { messages: [controls.help()] };

  if (lowered === "/status") {
    const workflowStatus = await runs.getWorkflowStatus(threadId, controlledState);
    return {
      messages: [
        [
          await controls.status(threadId, {
            ...controlledState,
            runStatus: status.runStatus,
          }),
          workflowStatus ? `workflow: ${workflowStatus}` : null,
        ]
          .filter(Boolean)
          .join("\n"),
      ],
    };
  }

  if (lowered === "/model") {
    if (!value) {
      return { messages: [renderModelStatus(runtimeDeps, controlledState)] };
    }
    if (busy) return { messages: [busyMessage(text.trim())] };
    const selected = findModelCatalogEntry(value);
    if (!selected) {
      return {
        messages: [
          `unknown model alias: ${value}\n${renderModelStatus(runtimeDeps, controlledState, true)}`,
        ],
      };
    }
    const next = {
      ...controlledState,
      modelAlias: selected.alias,
    };
    await saveThreadControls(runtimeDeps, threadId, { modelAlias: selected.alias });
    await setThreadStateSnapshot(runtimeDeps.DRECLAW_DB, threadId, next);
    return {
      messages: [`model set: ${selected.alias}\n${renderModelStatus(runtimeDeps, next)}`],
    };
  }

  if (lowered === "/stop") {
    if (!status.runStatus.running) return { messages: ["Nothing is running."] };
    await runs.requestStop(threadId, controlledState);
    return { messages: ["Stopped."] };
  }

  if (lowered === "/new") {
    if (busy) return { messages: [busyMessage(lowered)] };
    const next = controls.reset(controlledState);
    await setThreadStateSnapshot(runtimeDeps.DRECLAW_DB, threadId, next);
    return { messages: ["New session started. Conversation context cleared and settings kept."] };
  }

  if (lowered === "/reset") {
    if (busy) return { messages: [busyMessage(lowered)] };
    const next = {
      ...controls.reset(controlledState),
      verbose: THREAD_CONTROL_DEFAULTS.verbose,
      thinking: THREAD_CONTROL_DEFAULTS.thinking,
      reasoning: THREAD_CONTROL_DEFAULTS.reasoning,
    };
    await saveThreadControls(runtimeDeps, threadId, {
      verbose: THREAD_CONTROL_DEFAULTS.verbose,
      thinking: THREAD_CONTROL_DEFAULTS.thinking,
      reasoning: THREAD_CONTROL_DEFAULTS.reasoning,
    });
    await setThreadStateSnapshot(runtimeDeps.DRECLAW_DB, threadId, next);
    return {
      messages: ["Session reset. Conversation context cleared and chat defaults restored."],
    };
  }

  if (lowered === "/factory-reset") {
    if (busy) return { messages: [busyMessage(lowered)] };
    const next = await controls.factoryReset(channelId);
    await setPersistedThreadControls(runtimeDeps.DRECLAW_DB, threadId, {
      verbose: THREAD_CONTROL_DEFAULTS.verbose,
      thinking: THREAD_CONTROL_DEFAULTS.thinking,
      reasoning: THREAD_CONTROL_DEFAULTS.reasoning,
      modelAlias: null,
    });
    await setThreadStateSnapshot(runtimeDeps.DRECLAW_DB, threadId, next);
    return {
      messages: ["Factory reset complete. Conversation, memory, and workspace files cleared."],
    };
  }

  if (lowered === "/verbose") {
    return applyBooleanControl({
      control: "verbose",
      value,
      currentState: controlledState,
      updateState: (enabled) => controls.setVerbose(controlledState, enabled),
      persist: async (enabled) => saveThreadControls(runtimeDeps, threadId, { verbose: enabled }),
      saveSnapshot: async (next) => setThreadStateSnapshot(runtimeDeps.DRECLAW_DB, threadId, next),
    });
  }

  if (lowered === "/thinking") {
    return applyBooleanControl({
      control: "thinking",
      value,
      currentState: controlledState,
      updateState: (enabled) => ({ ...controlledState, thinking: enabled }),
      persist: async (enabled) => saveThreadControls(runtimeDeps, threadId, { thinking: enabled }),
      saveSnapshot: async (next) => setThreadStateSnapshot(runtimeDeps.DRECLAW_DB, threadId, next),
    });
  }

  if (lowered === "/reasoning") {
    return applyBooleanControl({
      control: "reasoning",
      value,
      currentState: controlledState,
      updateState: (enabled) => ({ ...controlledState, reasoning: enabled }),
      persist: async (enabled) => saveThreadControls(runtimeDeps, threadId, { reasoning: enabled }),
      saveSnapshot: async (next) => setThreadStateSnapshot(runtimeDeps.DRECLAW_DB, threadId, next),
    });
  }

  const pluginCommand = pluginRegistry.listCommands().find((item) => item.match(text));
  if (pluginCommand) {
    if (busy && pluginCommand.isBusySensitive?.(text)) {
      return { messages: [busyMessage(text.trim())] };
    }
    const result = await pluginCommand.execute(input);
    return typeof result === "string" ? { messages: [result] } : result;
  }

  return { messages: [controls.help()] };
}

function busyMessage(command: string): string {
  return `Currently busy. Not executed. Run ${command} again when not busy.`;
}

async function saveThreadControls(
  runtimeDeps: RuntimeDeps,
  threadId: string,
  patch: Partial<{
    verbose: boolean;
    thinking: boolean;
    reasoning: boolean;
    modelAlias: string | null;
  }>,
): Promise<void> {
  const persisted = await getPersistedThreadControls(runtimeDeps.DRECLAW_DB, threadId);
  const current = {
    verbose: THREAD_CONTROL_DEFAULTS.verbose,
    thinking: THREAD_CONTROL_DEFAULTS.thinking,
    reasoning: THREAD_CONTROL_DEFAULTS.reasoning,
    modelAlias: null,
    ...persisted,
  };
  await setPersistedThreadControls(runtimeDeps.DRECLAW_DB, threadId, {
    ...current,
    ...patch,
  });
}

function renderModelStatus(
  runtimeDeps: RuntimeDeps,
  state: BotThreadState,
  includeUsage = false,
): string {
  const runtime = getRuntimeConfig(runtimeDeps, state);
  const lines = [
    `current: ${getRuntimeAlias(state)}`,
    `target: ${runtime.provider} / ${runtime.model}`,
    `aliases: ${listRuntimeAliases().join(", ")}`,
  ];
  if (includeUsage) lines.push("usage: /model <alias>");
  return lines.join("\n");
}

async function applyBooleanControl(params: {
  control: "verbose" | "thinking" | "reasoning";
  value?: string;
  currentState: BotThreadState;
  updateState: (enabled: boolean) => BotThreadState;
  persist: (enabled: boolean) => Promise<void>;
  saveSnapshot: (state: BotThreadState) => Promise<void>;
}): Promise<CommandResult> {
  if (params.value !== "on" && params.value !== "off") {
    return {
      messages: [
        `${params.control}: ${params.currentState[params.control] ? "on" : "off"}\nusage: /${params.control} on|off`,
      ],
    };
  }
  const enabled = params.value === "on";
  const next = params.updateState(enabled);
  await params.persist(enabled);
  await params.saveSnapshot(next);
  return { messages: [`${params.control} ${enabled ? "enabled" : "disabled"}.`] };
}
