export type AssistantAgendaStatus = "open" | "done" | "cancelled";

export type AssistantAgendaOutcome =
  | "sent_message"
  | "silent"
  | "completed"
  | "cancelled"
  | "failed";

export type AssistantAgendaSchedule =
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

export interface AssistantProfile {
  timezone: string;
  primaryChatId: number | null;
  updatedAt: string;
}

export interface AssistantAgendaItem {
  id: string;
  kind: string;
  title: string;
  notes: string;
  status: AssistantAgendaStatus;
  priority: number;
  schedule: AssistantAgendaSchedule | null;
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

export interface AssistantWakeRun {
  id: string;
  agendaItemId: string;
  scheduledFor: string;
  startedAt: string;
  finishedAt: string | null;
  outcome: AssistantAgendaOutcome | null;
  summary: string | null;
  error: string | null;
  nextWakeAt: string | null;
}

export interface AgendaQueryFilter {
  status?: AssistantAgendaStatus;
  kind?: string;
  text?: string;
  dueBefore?: string;
  sourceChatId?: number;
}

export type AgendaUpdateInput =
  | {
      action: "create";
      item: {
        kind?: string;
        title: string;
        notes?: string;
        priority?: number;
        schedule?: AssistantAgendaSchedule | null;
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
        schedule?: AssistantAgendaSchedule | null;
        nextWakeAt?: string | null;
        sourceChatId?: number | null;
        status?: AssistantAgendaStatus;
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
