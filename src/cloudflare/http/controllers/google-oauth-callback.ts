import { createGoogleModule } from "../../../integrations/google";
import type { Env } from "../../../types";

export async function handleGoogleOAuthCallbackRequest(
  request: Request,
  env: Env,
): Promise<Response> {
  return createGoogleModule(env).handleOAuthCallback(request);
}
