import type { Env } from "./env";
import { ConversationWorkflow } from "./conversation-workflow";
import { ExecuteHost } from "./execute-host";
import { handleWorkerFetch } from "../core/http";

export default {
  async fetch(request, env, ctx): Promise<Response> {
    return handleWorkerFetch(request, env, ctx);
  },
  async queue(): Promise<void> {
    return;
  },
} satisfies ExportedHandler<Env>;

export { ConversationWorkflow };
export { ExecuteHost };
