import type { RuntimeDeps } from "../app/types";
import { getCodeExecutionConfig } from "../tools/code-exec";
import { createExecuteHostBindingFactory } from "./adapters/execute-host";
import { createMemoryGateway } from "./adapters/memory";
import { createWorkspaceGateway } from "./adapters/workspace";
import { createRunCoordinator } from "../loop/run";
import {
  createConversationLoopService,
  type ConversationLoopService,
} from "./services/conversation";
import { createRuntimeControlsService, type RuntimeControlsService } from "./services/controls";
import { createProactiveWakeService, type ProactiveWakeService } from "./services/proactive-wake";
import { createAgentTools, type CreateAgentTools } from "./tools/toolbox";
import { getRemindersPlugin } from "../../plugins/reminders";

export interface LoopServices {
  controls: RuntimeControlsService;
  conversation: ConversationLoopService;
  wake: ProactiveWakeService;
}

export function createLoopServices(
  deps: RuntimeDeps,
  executionContext?: ExecutionContext & {
    exports?: Record<string, (options?: { props?: unknown }) => any>;
  },
): LoopServices {
  const runs = createRunCoordinator({ db: deps.DRECLAW_DB, workflow: deps.CONVERSATION_WORKFLOW });
  const getCodeExecutionConfigSafe = () =>
    getCodeExecutionConfig(deps as unknown as Record<string, string | undefined>);
  const workspaceGateway = createWorkspaceGateway({
    db: deps.DRECLAW_DB,
    maxFileBytes: getCodeExecutionConfigSafe().limits.vfsMaxFileBytes,
  });
  const memoryGateway = createMemoryGateway(deps);
  const reminders = getRemindersPlugin(deps.pluginRegistry.getByName("reminders"));
  const createExecuteHostBinding = createExecuteHostBindingFactory({
    executionContext: executionContext as never,
    getCodeExecutionConfig: getCodeExecutionConfigSafe,
  });
  const createTools: CreateAgentTools = (input) =>
    createAgentTools(input, {
      runs,
      workspaceGateway,
      reminders,
      getCodeExecutionConfig: getCodeExecutionConfigSafe,
      createExecuteHostBinding,
      loader: deps.LOADER ?? null,
    });

  return {
    controls: createRuntimeControlsService({
      runtimeDeps: deps,
      runs,
      memoryGateway,
      googlePlugin: deps.pluginRegistry.getByName("google"),
    }),
    conversation: createConversationLoopService({
      runtimeDeps: deps,
      runs,
      workspaceGateway,
      memoryGateway,
      createTools,
    }),
    wake: createProactiveWakeService({
      runtimeDeps: deps,
      runs,
      workspaceGateway,
      memoryGateway,
      createTools,
    }),
  };
}

export type { RuntimeControlsService } from "./services/controls";
export type { ConversationLoopService } from "./services/conversation";
export type { ProactiveWakeService } from "./services/proactive-wake";
