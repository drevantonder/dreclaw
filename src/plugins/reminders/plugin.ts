import type {
  CorePlugin,
  ReminderQueryInput,
  ReminderUpdateCommand,
} from "../../core/plugins/types";
import type { WorkflowPort, ReminderWakeWorkflowPayload } from "../../core/loop/workflow";
import { REMINDERS_OWNED_TABLES } from "./tables";
import { createRemindersService, type RemindersService } from "./service";

export interface RemindersPluginDeps {
  db: D1Database;
  timezone?: string;
  wakeWorkflow?: WorkflowPort<ReminderWakeWorkflowPayload>;
}

export interface RemindersPlugin extends CorePlugin {
  queryReminders(
    filter?: ReminderQueryInput,
    limit?: number,
  ): ReturnType<RemindersService["query"]>;
  updateReminder(
    input: ReminderUpdateCommand,
    context?: { sourceChatId?: number | null },
  ): ReturnType<RemindersService["update"]>;
  getReminder(id: string): ReturnType<RemindersService["getItem"]>;
  listRecentReminderWakeRuns(
    reminderId: string,
    limit?: number,
  ): ReturnType<RemindersService["listRecentWakeRuns"]>;
  openReminderWakeRun(params: {
    reminderId: string;
    scheduledFor: string;
  }): ReturnType<RemindersService["openWakeRun"]>;
  finalizeReminderWake(params: {
    itemId: string;
    claimToken: string;
    runId: string;
    scheduledFor: string;
    outcome: string;
    summary: string | null;
    error?: string | null;
  }): ReturnType<RemindersService["finalizeWake"]>;
  ensureReminderProfile(input?: {
    timezone?: string | null;
    primaryChatId?: number | null;
  }): ReturnType<RemindersService["ensureProfile"]>;
  startReminderWorkflow(deps?: {
    workflow?: WorkflowPort<ReminderWakeWorkflowPayload>;
    limit?: number;
  }): Promise<void>;
}

export function createRemindersPlugin(deps: RemindersPluginDeps): RemindersPlugin {
  const service = createRemindersService(deps.db, { timezone: deps.timezone });
  return {
    name: "reminders",
    ownedTables: REMINDERS_OWNED_TABLES,
    migrationPrefix: "reminders",
    queryReminders: (filter, limit) => service.query(filter as never, limit),
    updateReminder: (input, context) => service.update(input as never, context),
    getReminder: (id) => service.getItem(id),
    listRecentReminderWakeRuns: (reminderId, limit) =>
      service.listRecentWakeRuns(reminderId, limit),
    openReminderWakeRun: (params) => service.openWakeRun(params),
    finalizeReminderWake: (params) => service.finalizeWake(params as never),
    ensureReminderProfile: (input) => service.ensureProfile(input),
    startReminderWorkflow: async (input) =>
      runReminderScheduling(service, input?.workflow ?? deps.wakeWorkflow, input?.limit ?? 10),
    onScheduled: async () => {
      await runReminderScheduling(service, deps.wakeWorkflow, 10);
    },
  };
}

export function getRemindersPlugin(plugin: CorePlugin | null): RemindersPlugin {
  if (!plugin || plugin.name !== "reminders") throw new Error("REMINDERS_PLUGIN_UNAVAILABLE");
  return plugin as RemindersPlugin;
}

async function runReminderScheduling(
  service: RemindersService,
  workflow: WorkflowPort<ReminderWakeWorkflowPayload> | undefined,
  limit: number,
) {
  if (!workflow) return;
  const claimed = await service.claimDue({ limit });
  for (const item of claimed) {
    if (!item.claimToken) continue;
    try {
      const workflowId = crypto.randomUUID();
      const instance = await workflow.create({
        id: workflowId,
        params: { reminderId: item.id, claimToken: item.claimToken },
      });
      await service.markWorkflowStarted({
        id: item.id,
        claimToken: item.claimToken,
        workflowId: instance.id,
      });
    } catch {
      await service.releaseClaim({ id: item.id, claimToken: item.claimToken });
    }
  }
}
