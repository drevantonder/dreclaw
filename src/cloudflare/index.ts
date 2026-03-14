import { handleTelegramWebhookRequest } from "../telegram/webhook";
import type { Env } from "../types";
import { ConversationWorkflow } from "./conversation-workflow";
import { ExecuteHost } from "./execute-host";
import { handleGoogleOAuthCallbackRequest } from "./http/controllers/google-oauth-callback";
import { handleHealthRequest } from "./http/controllers/health";

export default {
  async fetch(request, env, ctx): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return handleHealthRequest();
    }

    if (request.method === "POST" && url.pathname === "/telegram/webhook") {
      return handleTelegramWebhookRequest(request, env, ctx);
    }

    if (request.method === "GET" && url.pathname === "/google/oauth/callback") {
      return handleGoogleOAuthCallbackRequest(request, env);
    }

    return new Response("Not found", { status: 404 });
  },
  async queue(): Promise<void> {
    return;
  },
} satisfies ExportedHandler<Env>;

export { ConversationWorkflow };
export { ExecuteHost };
