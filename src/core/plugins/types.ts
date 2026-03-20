import type { CommandContext, CommandResult } from "../app/types";
import type { AppEffect } from "../effects";
import type { ReminderWakeWorkflowPayload, WorkflowPort } from "../loop/workflow";

export interface ReminderRecord {
  id: string;
  title: string;
  notes: string;
  kind: string;
  delivery: "visible" | "silent";
  priority: number;
  nextWakeAt: string | null;
  sourceChatId: number | null;
  claimToken: string | null;
}

export interface ReminderQueryInput {
  status?: "open" | "done" | "cancelled";
  kind?: string;
  text?: string;
  dueBefore?: string;
  sourceChatId?: number;
}

export type ReminderUpdateCommand =
  | {
      action: "create";
      item: {
        kind?: string;
        title: string;
        notes?: string;
        delivery?: "visible" | "silent";
        priority?: number;
        schedule?: unknown;
        nextWakeAt?: string | null;
        sourceChatId?: number | null;
      };
    }
  | {
      action: "patch";
      itemId: string;
      patch: {
        kind?: string;
        title?: string;
        notes?: string;
        delivery?: "visible" | "silent";
        priority?: number;
        schedule?: unknown;
        nextWakeAt?: string | null;
        sourceChatId?: number | null;
        status?: "open" | "done" | "cancelled";
      };
    }
  | { action: "complete" | "cancel"; itemId: string }
  | { action: "snooze" | "reschedule"; itemId: string; nextWakeAt: string }
  | { action: "append_note"; itemId: string; note: string };

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
  ownedTables?: string[];
  migrationPrefix?: string;
  commands?: CorePluginCommand[];
  handleOAuthCallback?(request: Request): Promise<OAuthCallbackResult>;
  onScheduled?(ctx: { nowIso: string }): Promise<void>;
  isLinked?(): Promise<boolean>;
  queryReminders?(filter?: ReminderQueryInput, limit?: number): Promise<ReminderRecord[]>;
  updateReminder?(
    input: ReminderUpdateCommand,
    context?: { sourceChatId?: number | null },
  ): Promise<unknown>;
  getReminder?(id: string): Promise<ReminderRecord | null>;
  listRecentReminderWakeRuns?(
    reminderId: string,
    limit?: number,
  ): Promise<Array<{ summary: string | null }>>;
  openReminderWakeRun?(params: { reminderId: string; scheduledFor: string }): Promise<string>;
  finalizeReminderWake?(params: {
    itemId: string;
    claimToken: string;
    runId: string;
    scheduledFor: string;
    outcome: string;
    summary: string | null;
    error?: string | null;
  }): Promise<ReminderRecord>;
  ensureReminderProfile?(input?: {
    timezone?: string | null;
    primaryChatId?: number | null;
  }): Promise<{ primaryChatId: number | null }>;
  startReminderWorkflow?(deps: {
    workflow?: WorkflowPort<ReminderWakeWorkflowPayload>;
    limit?: number;
  }): Promise<void>;
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
  runScheduled(ctx: { nowIso: string }): Promise<void>;
  getOAuthCallbackHandler(
    name: string,
  ): ((request: Request) => Promise<OAuthCallbackResult>) | undefined;
  getByName(name: string): CorePlugin | null;
}
