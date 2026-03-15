import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { runRemindersWakeWorkflow } from "../app/cloudflare";
import type { Env, ReminderWakeWorkflowPayload } from "./env";

export class RemindersWakeWorkflow extends WorkflowEntrypoint<Env, ReminderWakeWorkflowPayload> {
  async run(event: WorkflowEvent<ReminderWakeWorkflowPayload>, step: WorkflowStep): Promise<void> {
    return runRemindersWakeWorkflow(this.env, this.ctx as unknown as ExecutionContext, event, step);
  }
}
