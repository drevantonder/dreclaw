import { handleGoogleOAuthCallback } from "./callback";
import { getGoogleAccessToken, isGoogleLinked } from "./client";
import { handleGoogleCommand, isBusySensitiveGoogleCommand, isGoogleCommandText } from "./commands";
import { executeGoogleRequest } from "./execute";
import type { GooglePluginDeps } from "./types";

export function createGooglePlugin(deps: GooglePluginDeps) {
  return {
    name: "google",
    commands: [
      {
        match: (text: string) => isGoogleCommandText(text),
        isBusySensitive: (text: string) => isBusySensitiveGoogleCommand(text),
        execute: (input: Parameters<typeof handleGoogleCommand>[1]) =>
          handleGoogleCommand(deps, input),
      },
    ],
    handleOAuthCallback: (request: Request) => handleGoogleOAuthCallback(request, deps),
    isLinked: () => isGoogleLinked(deps),
    getAccessToken: (timeoutMs: number) => getGoogleAccessToken(deps, timeoutMs),
    execute: (
      payload: {
        service?: string;
        version?: string;
        method?: string;
        params?: Record<string, unknown>;
        body?: unknown;
      },
      options: { allowedServices: string[]; timeoutMs: number },
    ) => executeGoogleRequest(deps, payload, options),
  };
}

export type { GoogleOAuthConfig } from "./config";
