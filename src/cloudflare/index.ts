import { handleHttpRequest, handleScheduled } from "../app/cloudflare";
import type { Env } from "./env";
import { ConversationWorkflow } from "./conversation-workflow";
import { RemindersWakeWorkflow } from "./reminders-wake-workflow";

export default {
  async fetch(request, env, ctx): Promise<Response> {
    return handleHttpRequest(request, env, ctx);
  },
  async queue(): Promise<void> {
    return;
  },
  async scheduled(_controller, env, ctx): Promise<void> {
    ctx.waitUntil(handleScheduled(env));
  },
} satisfies ExportedHandler<Env>;

export { ConversationWorkflow };
export { RemindersWakeWorkflow };
