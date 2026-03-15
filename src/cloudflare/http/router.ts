import type { Env } from "../env";
import { handleHttpRequest as handleAppHttpRequest } from "../../app/cloudflare";

export async function handleHttpRequest(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  return handleAppHttpRequest(request, env, ctx);
}
