import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { createAgendaService } from "../core/agenda";
import { BotRuntime } from "../core/loop/runtime";
import { getThreadStateSnapshot, setThreadStateSnapshot } from "../core/loop/repo";
import { normalizeBotThreadState } from "../core/loop/state";
import type { Env, ProactiveWakeWorkflowPayload } from "./env";
import { sendTelegramTextMessage } from "../chat-adapters/telegram/api";

export class ProactiveWakeWorkflow extends WorkflowEntrypoint<Env, ProactiveWakeWorkflowPayload> {
  async run(event: WorkflowEvent<ProactiveWakeWorkflowPayload>, step: WorkflowStep): Promise<void> {
    const agenda = createAgendaService(this.env.DRECLAW_DB, {
      timezone: this.env.USER_TIMEZONE,
    });
    const item = await agenda.getItem(event.payload.agendaItemId);
    if (!item || item.claimToken !== event.payload.claimToken) return;

    const profile = await agenda.ensureProfile({ primaryChatId: item.sourceChatId ?? null });
    const chatId = item.sourceChatId ?? profile.primaryChatId;
    if (!chatId) {
      const runId = await agenda.openWakeRun({
        agendaItemId: item.id,
        scheduledFor: item.nextWakeAt ?? new Date().toISOString(),
      });
      await agenda.finalizeWake({
        itemId: item.id,
        claimToken: event.payload.claimToken,
        runId,
        scheduledFor: item.nextWakeAt ?? new Date().toISOString(),
        outcome: "failed",
        summary: "Missing primary chat id for proactive wake",
        error: "Missing primary chat id for proactive wake",
      });
      return;
    }

    const threadId = `telegram:${chatId}`;
    const runId = await agenda.openWakeRun({
      agendaItemId: item.id,
      scheduledFor: item.nextWakeAt ?? new Date().toISOString(),
    });
    const recentWakeRuns = await agenda.listRecentWakeRuns(item.id, 5);

    try {
      const result = await step.do("run-proactive-wake", async () => {
        const runtime = new BotRuntime(this.env, this.ctx as unknown as ExecutionContext);
        const state = normalizeBotThreadState(
          await getThreadStateSnapshot(this.env.DRECLAW_DB, threadId),
        );
        return runtime.runProactiveWake({
          threadId,
          chatId,
          state,
          item,
          recentWakeSummaries: recentWakeRuns
            .filter((wakeRun) => wakeRun.summary)
            .map((wakeRun) => String(wakeRun.summary)),
        });
      });

      await setThreadStateSnapshot(this.env.DRECLAW_DB, threadId, result.state);
      if (result.messageText) {
        await step.do("send-proactive-message", async () => {
          await sendTelegramTextMessage(this.env.TELEGRAM_BOT_TOKEN, chatId, result.messageText!);
        });
      }

      await agenda.finalizeWake({
        itemId: item.id,
        claimToken: event.payload.claimToken,
        runId,
        scheduledFor: item.nextWakeAt ?? new Date().toISOString(),
        outcome: result.messageText ? "sent_message" : "silent",
        summary: result.summary,
      });
    } catch (error) {
      await agenda.finalizeWake({
        itemId: item.id,
        claimToken: event.payload.claimToken,
        runId,
        scheduledFor: item.nextWakeAt ?? new Date().toISOString(),
        outcome: "failed",
        summary: error instanceof Error ? error.message : "Proactive wake failed",
        error:
          error instanceof Error
            ? error.message
            : typeof error === "string"
              ? error
              : "Proactive wake failed",
      });
      throw error;
    }
  }
}
