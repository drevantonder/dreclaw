import type { SerializedMessage, SerializedThread } from "chat";

export interface ConversationWorkflowPayload {
  thread: SerializedThread;
  message: SerializedMessage;
  state: unknown;
  traceId?: string;
  channelId?: number;
  imageBlocks?: string[];
}

export interface ReminderWakeWorkflowPayload {
  reminderId: string;
  claimToken: string;
}

export interface WorkflowInstance {
  id: string;
}

export interface WorkflowControlInstance {
  terminate(): Promise<unknown>;
  status(): Promise<{ status: string }>;
}

export interface WorkflowPort<TPayload> {
  create(input: { id: string; params: TPayload }): Promise<WorkflowInstance>;
  get(id: string): Promise<WorkflowControlInstance>;
}
