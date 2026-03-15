import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { runConversationWorkflow } from "../app/cloudflare";
import type { ConversationWorkflowPayload, Env } from "./env";

export class ConversationWorkflow extends WorkflowEntrypoint<Env, ConversationWorkflowPayload> {
  async run(event: WorkflowEvent<ConversationWorkflowPayload>, step: WorkflowStep): Promise<void> {
    return runConversationWorkflow(this.env, this.ctx as unknown as ExecutionContext, event, step);
  }
}
