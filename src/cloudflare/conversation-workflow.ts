import { Message as ChatMessage, ThreadImpl } from "chat";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { ModelMessage } from "ai";
import { BotRuntime } from "../app/runtime";
import type { BotThreadState } from "../app/state";
import { createRunCoordinator } from "../run";
import { createChat } from "../telegram/gateway";
import { getTelegramUserChatId, loadTelegramImageBlocks } from "../telegram/message";
import type { ConversationWorkflowPayload, Env } from "../types";

export class ConversationWorkflow extends WorkflowEntrypoint<Env, ConversationWorkflowPayload> {
  async run(event: WorkflowEvent<ConversationWorkflowPayload>, step: WorkflowStep): Promise<void> {
    const runs = createRunCoordinator(this.env);
    let state = await runs.restoreWorkflowState({
      threadId: event.payload.thread.id,
      state: event.payload.state as BotThreadState,
      payloadState: event.payload.state,
    });
    let messages: unknown[] | undefined;
    let shouldContinue = true;

    for (let stepIndex = 0; stepIndex < 64 && shouldContinue; stepIndex += 1) {
      const rawResult = await step.do(`conversation-step-${stepIndex}`, async () => {
        const chat = createChat(this.env).registerSingleton();
        void chat;
        const thread = ThreadImpl.fromJSON<BotThreadState>(event.payload.thread);
        const message = ChatMessage.fromJSON(event.payload.message);
        const runtime = new BotRuntime(this.env, this.ctx as unknown as ExecutionContext);
        const chatId = getTelegramUserChatId(message.raw, thread.id);
        const imageBlocks = await loadTelegramImageBlocks(this.env.TELEGRAM_BOT_TOKEN, message.raw);
        const stepResult = await runtime.runConversationAgentStep({
          thread,
          message,
          chatId,
          state,
          imageBlocks,
          baseMessages: Array.isArray(messages) ? (messages as ModelMessage[]) : undefined,
          isFirstStep: stepIndex === 0,
          runTimeoutMs: 300_000,
        });
        await thread.setState(stepResult.state as unknown as Record<string, unknown>, {
          replace: true,
        });
        return {
          stateJson: JSON.stringify(stepResult.state),
          nextMessagesJson: JSON.stringify(stepResult.nextMessages),
          shouldContinue: stepResult.shouldContinue,
        };
      });
      const result = rawResult as {
        stateJson: string;
        nextMessagesJson: string;
        shouldContinue: boolean;
      };

      state = await runs.restoreWorkflowState({
        threadId: event.payload.thread.id,
        state,
        payloadState: JSON.parse(String(result.stateJson ?? "{}")),
      });
      messages = JSON.parse(String(result.nextMessagesJson ?? "[]")) as unknown[];
      shouldContinue = Boolean(result.shouldContinue);
    }

    const chat = createChat(this.env).registerSingleton();
    void chat;
    const thread = ThreadImpl.fromJSON<BotThreadState>(event.payload.thread);
    await thread.setState(state as unknown as Record<string, unknown>, { replace: true });
    await runs.clearWorkflowInstance(thread.id);
  }
}
