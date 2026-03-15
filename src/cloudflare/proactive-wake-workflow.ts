import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { runProactiveWakeWorkflow } from "../app/cloudflare";
import type { Env, ProactiveWakeWorkflowPayload } from "./env";

export class ProactiveWakeWorkflow extends WorkflowEntrypoint<Env, ProactiveWakeWorkflowPayload> {
  async run(event: WorkflowEvent<ProactiveWakeWorkflowPayload>, step: WorkflowStep): Promise<void> {
    return runProactiveWakeWorkflow(this.env, this.ctx as unknown as ExecutionContext, event, step);
  }
}
