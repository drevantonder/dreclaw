export class WorkflowEntrypoint<Env = unknown> {
  protected env: Env;
  protected ctx: ExecutionContext;

  constructor(ctx: ExecutionContext, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}

export class WorkerEntrypoint<Env = unknown, Props = unknown> {
  protected env: Env;
  protected ctx: ExecutionContext & { props?: Props };

  constructor(ctx: ExecutionContext & { props?: Props }, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}
