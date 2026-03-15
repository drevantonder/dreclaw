import { createAgendaService } from "../core/agenda";
import type { Env } from "./env";
import { ConversationWorkflow } from "./conversation-workflow";
import { ExecuteHost } from "./execute-host";
import { ProactiveWakeWorkflow } from "./proactive-wake-workflow";
import { handleHttpRequest } from "./http/router";

export default {
  async fetch(request, env, ctx): Promise<Response> {
    return handleHttpRequest(request, env, ctx);
  },
  async queue(): Promise<void> {
    return;
  },
  async scheduled(_controller, env, ctx): Promise<void> {
    ctx.waitUntil(processDueAgendaItems(env));
  },
} satisfies ExportedHandler<Env>;

export { ConversationWorkflow };
export { ExecuteHost };
export { ProactiveWakeWorkflow };

async function processDueAgendaItems(env: Env): Promise<void> {
  if (!env.PROACTIVE_WAKE_WORKFLOW) return;
  const agenda = createAgendaService(env.DRECLAW_DB, { timezone: env.USER_TIMEZONE });
  const claimed = await agenda.claimDue({ limit: 10 });
  for (const item of claimed) {
    if (!item.claimToken) continue;
    try {
      const workflowId = crypto.randomUUID();
      const instance = await env.PROACTIVE_WAKE_WORKFLOW.create({
        id: workflowId,
        params: {
          agendaItemId: item.id,
          claimToken: item.claimToken,
        },
      });
      await agenda.markWorkflowStarted({
        id: item.id,
        claimToken: item.claimToken,
        workflowId: instance.id,
      });
    } catch {
      await agenda.releaseClaim({ id: item.id, claimToken: item.claimToken });
    }
  }
}
