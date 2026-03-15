import type { Env } from "../../cloudflare/env";
import { sendTelegramTextMessage } from "../../chat-adapters/telegram/api";
import { createPluginRegistry } from "../plugins/registry";
import { BotRuntime } from "../loop/runtime";
import {
  getThreadStateSnapshot,
  setPersistedThreadControls,
  setThreadStateSnapshot,
} from "../loop/repo";
import { normalizeBotThreadState, type BotThreadState } from "../loop/state";
import { createRunCoordinator } from "../loop/run";

export async function maybeHandleAsyncCoreCommand(
  env: Env,
  input: {
    threadId: string;
    chatId: number;
    telegramUserId: number;
    text: string;
    executionContext?: ExecutionContext;
  },
): Promise<boolean> {
  const text = input.text.trim();
  if (!text.startsWith("/")) return false;
  const result = await handleAsyncCommand({
    env,
    runtime: new BotRuntime(env, input.executionContext),
    threadId: input.threadId,
    chatId: input.chatId,
    telegramUserId: input.telegramUserId,
    text,
  });
  await publishCommandResult(env, input.chatId, result.messages);
  return true;
}

export async function handleAsyncCommand(params: {
  env: Env;
  runtime: BotRuntime;
  threadId: string;
  chatId: number;
  telegramUserId: number;
  text: string;
}): Promise<{ messages: string[] }> {
  const { env, runtime, threadId, chatId, telegramUserId, text } = params;
  const [command, value] = text.split(/\s+/, 2);
  const lowered = command.toLowerCase();
  const runs = createRunCoordinator(env);
  const snapshot = normalizeBotThreadState(
    await getThreadStateSnapshot<BotThreadState>(env.DRECLAW_DB, threadId),
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
    await setPersistedThreadControls(env.DRECLAW_DB, threadId, { verbose: false });
    await setThreadStateSnapshot(env.DRECLAW_DB, threadId, next);
    return { messages: ["Session reset. Conversation context cleared."] };
  }

  if (lowered === "/factory-reset") {
    if (busy) return { messages: [busyMessage(lowered)] };
    const next = await runtime.factoryReset(chatId);
    await setPersistedThreadControls(env.DRECLAW_DB, threadId, { verbose: false });
    await setThreadStateSnapshot(env.DRECLAW_DB, threadId, next);
    return { messages: ["Factory reset complete. Conversation, memory, and VFS cleared."] };
  }

  if (lowered === "/verbose") {
    if (value !== "on" && value !== "off") {
      return {
        messages: [`verbose: ${snapshot.verbose ? "on" : "off"}\nusage: /verbose on|off`],
      };
    }
    const next = runtime.setVerbose(controlledState, value === "on");
    await setPersistedThreadControls(env.DRECLAW_DB, threadId, { verbose: value === "on" });
    await setThreadStateSnapshot(env.DRECLAW_DB, threadId, next);
    return { messages: [`verbose ${value === "on" ? "enabled" : "disabled"}.`] };
  }

  const registry = createPluginRegistry(env);
  const pluginCommand = registry.listCommands().find((item) => item.match(text));
  if (pluginCommand) {
    if (busy && pluginCommand.isBusySensitive?.(text)) {
      return { messages: [busyMessage(text.trim())] };
    }
    return {
      messages: [await pluginCommand.execute({ text, chatId, telegramUserId })],
    };
  }

  return { messages: [runtime.help()] };
}

export async function publishCommandResult(
  env: Pick<Env, "TELEGRAM_BOT_TOKEN">,
  chatId: number,
  messages: string[],
): Promise<void> {
  for (const message of messages) {
    await sendTelegramTextMessage(env.TELEGRAM_BOT_TOKEN, chatId, message);
  }
}

function busyMessage(command: string): string {
  return `Currently busy. Not executed. Run ${command} again when not busy.`;
}
