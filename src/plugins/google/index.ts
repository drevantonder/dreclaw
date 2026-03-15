import type { Env } from "../../cloudflare/env";
import { handleGoogleOAuthCallback } from "./callback";
import { getGoogleAccessToken, isGoogleLinked } from "./client";
import { handleGoogleCommand, isBusySensitiveGoogleCommand, isGoogleCommandText } from "./commands";
import { executeGoogleRequest } from "./execute";

export function createGooglePlugin(env: Env) {
  return {
    name: "google",
    commands: [
      {
        match: (text: string) => isGoogleCommandText(text),
        isBusySensitive: (text: string) => isBusySensitiveGoogleCommand(text),
        execute: (input: { text: string; chatId: number; telegramUserId: number }) =>
          handleGoogleCommand(env, input),
      },
    ],
    handleOAuthCallback: (request: Request) => handleGoogleOAuthCallback(request, env),
    isLinked: () => isGoogleLinked(env),
    getAccessToken: (timeoutMs: number) => getGoogleAccessToken(env, timeoutMs),
    execute: (
      payload: {
        service?: string;
        version?: string;
        method?: string;
        params?: Record<string, unknown>;
        body?: unknown;
      },
      options: { allowedServices: string[]; timeoutMs: number },
    ) => executeGoogleRequest(env, payload, options),
  };
}

export type { GoogleOAuthConfig } from "./config";
