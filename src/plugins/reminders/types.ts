export type ReminderStatus = "open" | "done" | "cancelled";

export type ReminderOutcome = "sent_message" | "silent" | "completed" | "cancelled" | "failed";

export type ReminderSchedule =
  | {
      type: "once";
      atLocal: string;
    }
  | {
      type: "recurring";
      cadence: "daily" | "weekdays" | "weekly" | "monthly";
      atLocalTime: string;
      daysOfWeek?: number[];
      dayOfMonth?: number;
      interval?: number;
    };

export interface ReminderProfile {
  timezone: string;
  primaryChatId: number | null;
  updatedAt: string;
}

export interface Reminder {
  id: string;
  kind: string;
  title: string;
  notes: string;
  status: ReminderStatus;
  priority: number;
  schedule: ReminderSchedule | null;
  nextWakeAt: string | null;
  lastWakeAt: string | null;
  snoozeUntil: string | null;
  sourceChatId: number | null;
  claimedAt: string | null;
  claimToken: string | null;
  workflowId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReminderRun {
  id: string;
  reminderId: string;
  scheduledFor: string;
  startedAt: string;
  finishedAt: string | null;
  outcome: ReminderOutcome | null;
  summary: string | null;
  error: string | null;
  nextWakeAt: string | null;
}

export interface ReminderQueryFilter {
  status?: ReminderStatus;
  kind?: string;
  text?: string;
  dueBefore?: string;
  sourceChatId?: number;
}

export type ReminderUpdateInput =
  | {
      action: "create";
      item: {
        kind?: string;
        title: string;
        notes?: string;
        priority?: number;
        schedule?: ReminderSchedule | null;
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
        priority?: number;
        schedule?: ReminderSchedule | null;
        nextWakeAt?: string | null;
        sourceChatId?: number | null;
        status?: ReminderStatus;
      };
    }
  | {
      action: "complete" | "cancel";
      itemId: string;
    }
  | {
      action: "snooze" | "reschedule";
      itemId: string;
      nextWakeAt: string;
    }
  | {
      action: "append_note";
      itemId: string;
      note: string;
    };
