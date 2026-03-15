import type { CommandContext, CommandResult } from "../app/types";
import type { AppEffect } from "../effects";

export interface CorePluginCommand {
  match(text: string): boolean;
  isBusySensitive?(text: string): boolean;
  execute(input: CommandContext): Promise<string | CommandResult>;
}

export interface OAuthCallbackResult {
  status: number;
  title: string;
  body: string;
  effects?: AppEffect[];
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
  (): CorePlugin;
}

export interface PluginRegistry {
  list(): CorePlugin[];
  listCommands(): CorePluginCommand[];
  getOAuthCallbackHandler(
    name: string,
  ): ((request: Request) => Promise<OAuthCallbackResult>) | undefined;
  getByName(name: string): CorePlugin | null;
}
