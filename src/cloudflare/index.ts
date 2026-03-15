import type { Env } from "./env";
import { ConversationWorkflow } from "./conversation-workflow";
import { ExecuteHost } from "./execute-host";
import { handleHttpRequest } from "./http/router";

export default {
  async fetch(request, env, ctx): Promise<Response> {
    return handleHttpRequest(request, env, ctx);
  },
  async queue(): Promise<void> {
    return;
  },
} satisfies ExportedHandler<Env>;

export { ConversationWorkflow };
export { ExecuteHost };
