import type { Env } from "../../cloudflare/env";

export interface CorePluginCommand {
  match(text: string): boolean;
  isBusySensitive?(text: string): boolean;
  execute(input: { text: string; chatId: number; telegramUserId: number }): Promise<string>;
}

export interface OAuthCallbackResult {
  status: number;
  title: string;
  body: string;
  notifyTelegram?: { chatId: number; text: string };
}

export interface CorePlugin {
  name: string;
  commands?: CorePluginCommand[];
  handleOAuthCallback?(request: Request): Promise<OAuthCallbackResult>;
  isLinked?(): Promise<boolean>;
  execute?(
    payload: {
      service?: string;
      version?: string;
      method?: string;
      params?: Record<string, unknown>;
      body?: unknown;
    },
    options: { allowedServices: string[]; timeoutMs: number },
  ): Promise<unknown>;
}

export interface PluginFactory {
  (env: Env): CorePlugin;
}
