import type { Env } from "../../cloudflare/env";
import { handleGoogleCommand } from "./commands";
import { getGoogleAccessToken, isGoogleLinked } from "./client";
import { GOOGLE_OAUTH_DEFAULT_PRINCIPAL, getGoogleOAuthConfig, parseGoogleScopes } from "./config";
import { handleGoogleOAuthCallback } from "./callback";
import { isBusySensitiveGoogleCommand, isGoogleCommandText } from "./commands";
import {
  buildGoogleOAuthUrl,
  createOAuthStateToken,
  exchangeGoogleOAuthCode,
  refreshGoogleAccessToken,
} from "./oauth";
import {
  createGoogleOAuthState,
  deleteGoogleOAuthToken,
  getGoogleOAuthState,
  getGoogleOAuthToken,
  markGoogleOAuthStateUsed,
  upsertGoogleOAuthToken,
} from "./repo";
import { executeGoogleRequest } from "./execute";

export function createGoogleModule(env: Env) {
  return {
    isLinked: () => isGoogleLinked(env),
    getAccessToken: (timeoutMs: number) => getGoogleAccessToken(env, timeoutMs),
    isCommandText: (text: string) => isGoogleCommandText(text),
    isBusySensitiveCommand: (text: string) => isBusySensitiveGoogleCommand(text),
    handleCommand: (input: { text: string; chatId: number; telegramUserId: number }) =>
      handleGoogleCommand(env, input),
    handleOAuthCallback: (request: Request) => handleGoogleOAuthCallback(request, env),
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

export {
  GOOGLE_OAUTH_DEFAULT_PRINCIPAL,
  buildGoogleOAuthUrl,
  createGoogleOAuthState,
  createOAuthStateToken,
  deleteGoogleOAuthToken,
  exchangeGoogleOAuthCode,
  getGoogleAccessToken,
  getGoogleOAuthConfig,
  getGoogleOAuthState,
  getGoogleOAuthToken,
  handleGoogleCommand,
  handleGoogleOAuthCallback,
  isBusySensitiveGoogleCommand,
  isGoogleCommandText,
  markGoogleOAuthStateUsed,
  parseGoogleScopes,
  refreshGoogleAccessToken,
  upsertGoogleOAuthToken,
};

export type { GoogleOAuthConfig } from "./config";
export type { GoogleTokenExchangeResult, GoogleTokenRefreshResult } from "./oauth";
export type { GoogleOAuthStateRecord, GoogleOAuthTokenRecord } from "./repo";
