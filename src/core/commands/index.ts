import type { CommandContext, CommandResult, RuntimeDeps } from "../app/types";
import { createAgendaService } from "../agenda";
import type { PluginRegistry } from "../plugins/types";
import { BotRuntime } from "../loop/runtime";
import {
  getThreadStateSnapshot,
  setPersistedThreadControls,
  setThreadStateSnapshot,
} from "../loop/repo";
import { normalizeBotThreadState, type BotThreadState } from "../loop/state";
import { createRunCoordinator } from "../loop/run";

export interface CommandDeps {
  runtimeDeps: RuntimeDeps;
  runtime: BotRuntime;
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
  const { runtimeDeps, runtime, pluginRegistry } = deps;
  const { threadId, channelId, text } = input;
  await createAgendaService(runtimeDeps.DRECLAW_DB, {
    timezone: runtimeDeps.USER_TIMEZONE,
    primaryChatId: channelId,
  }).ensureProfile({ primaryChatId: channelId });
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

  if (lowered === "/help") return { messages: [runtime.help()] };

  if (lowered === "/status") {
    const workflowStatus = await runs.getWorkflowStatus(threadId, controlledState);
    return {
      messages: [
        [
          await runtime.status(threadId, {
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

  if (lowered === "/stop") {
    if (!status.runStatus.running) return { messages: ["Nothing is running."] };
    await runs.requestStop(threadId, controlledState);
    return { messages: ["Stopped."] };
  }

  if (lowered === "/reset") {
    if (busy) return { messages: [busyMessage(lowered)] };
    const next = runtime.reset(controlledState);
    await setPersistedThreadControls(runtimeDeps.DRECLAW_DB, threadId, { verbose: false });
    await setThreadStateSnapshot(runtimeDeps.DRECLAW_DB, threadId, next);
    return { messages: ["Session reset. Conversation context cleared."] };
  }

  if (lowered === "/factory-reset") {
    if (busy) return { messages: [busyMessage(lowered)] };
    const next = await runtime.factoryReset(channelId);
    await setPersistedThreadControls(runtimeDeps.DRECLAW_DB, threadId, { verbose: false });
    await setThreadStateSnapshot(runtimeDeps.DRECLAW_DB, threadId, next);
    return { messages: ["Factory reset complete. Conversation, memory, and VFS cleared."] };
  }

  if (lowered === "/verbose") {
    if (value !== "on" && value !== "off") {
      return {
        messages: [`verbose: ${snapshot.verbose ? "on" : "off"}\nusage: /verbose on|off`],
      };
    }
    const next = runtime.setVerbose(controlledState, value === "on");
    await setPersistedThreadControls(runtimeDeps.DRECLAW_DB, threadId, { verbose: value === "on" });
    await setThreadStateSnapshot(runtimeDeps.DRECLAW_DB, threadId, next);
    return { messages: [`verbose ${value === "on" ? "enabled" : "disabled"}.`] };
  }

  const pluginCommand = pluginRegistry.listCommands().find((item) => item.match(text));
  if (pluginCommand) {
    if (busy && pluginCommand.isBusySensitive?.(text)) {
      return { messages: [busyMessage(text.trim())] };
    }
    const result = await pluginCommand.execute(input);
    return typeof result === "string" ? { messages: [result] } : result;
  }

  return { messages: [runtime.help()] };
}

function busyMessage(command: string): string {
  return `Currently busy. Not executed. Run ${command} again when not busy.`;
}
