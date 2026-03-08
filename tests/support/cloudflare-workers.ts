export class WorkflowEntrypoint<Env = unknown> {
  protected env: Env;
  protected ctx: ExecutionContext;

  constructor(ctx: ExecutionContext, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}
