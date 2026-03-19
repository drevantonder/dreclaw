import type { Message, SerializedThread, Thread } from "chat";
import type { RunCoordinatorDeps } from "../app/types";
import type { ConversationWorkflowPayload } from "./workflow";
import type { BotThreadState, RunStatus } from "./state";
import { normalizeBotThreadState } from "./state";
import {
  clearPersistedWorkflowInstanceId,
  finalizePersistedRunStop,
  getPersistedRunStatus,
  getPersistedThreadControls,
  getPersistedWorkflowInstanceId,
  requestPersistedRunStop,
  setPersistedRunStatus,
  setPersistedWorkflowInstanceId,
  setThreadStateSnapshot,
} from "./repo";

const RUN_ACTIVE_WINDOW_MS = 15_000;
const RUN_HEARTBEAT_INTERVAL_MS = 4_000;

type WorkflowThread = Thread<BotThreadState> & { toJSON(): SerializedThread };

export class RunCancelledError extends Error {
  constructor() {
    super("Run cancelled");
  }
}

export function createRunCoordinator(
  deps:
    | RunCoordinatorDeps
    | { DRECLAW_DB: D1Database; CONVERSATION_WORKFLOW?: RunCoordinatorDeps["workflow"] },
) {
  return new RunCoordinator(
    "db" in deps
      ? deps
      : {
          db: deps.DRECLAW_DB,
          workflow: deps.CONVERSATION_WORKFLOW,
        },
  );
}

export class RunCoordinator {
  constructor(private readonly deps: RunCoordinatorDeps) {}

  async inspect(threadId: string, fallbackState: BotThreadState) {
    const state = normalizeBotThreadState(fallbackState);
    const controls = await getPersistedThreadControls(this.deps.db, threadId);
    const workflowInstanceId = await getPersistedWorkflowInstanceId(this.deps.db, threadId);
    const runStatus = withWorkflowInstanceId(
      (await getPersistedRunStatus(this.deps.db, threadId)) ?? state.runStatus,
      workflowInstanceId,
    );
    return {
      state: {
        ...state,
        verbose: controls?.verbose ?? state.verbose,
        modelAlias:
          typeof controls?.modelAlias === "string" && controls.modelAlias.trim()
            ? controls.modelAlias.trim().toLowerCase()
            : state.modelAlias,
        runStatus,
      },
      runStatus,
      workflowInstanceId,
      busy: isRunBusy(runStatus),
    };
  }

  async recoverState(threadId: string, fallbackState: BotThreadState): Promise<BotThreadState> {
    return (await this.inspect(threadId, fallbackState)).state;
  }

  async getStatus(threadId: string, fallbackState: BotThreadState) {
    const { runStatus, workflowInstanceId } = await this.inspect(threadId, fallbackState);
    return {
      runStatus,
      workflowInstanceId,
      busy: formatBusyState(runStatus),
      runningFor: isRunStatusActive(runStatus) ? formatDurationSince(runStatus.startedAt) : "-",
      lastHeartbeat: formatElapsedSince(runStatus.lastHeartbeatAt),
    };
  }

  idleRunStatus(): RunStatus {
    return idleRunStatus();
  }

  startRun(state: BotThreadState, workflowInstanceId?: string | null): BotThreadState {
    const nowIso = new Date().toISOString();
    return {
      ...state,
      runStatus: {
        ...state.runStatus,
        running: true,
        startedAt: nowIso,
        lastHeartbeatAt: nowIso,
        cancelRequested: false,
        cancelRequestedAt: null,
        stoppedAt: null,
        workflowInstanceId: workflowInstanceId ?? state.runStatus.workflowInstanceId ?? null,
      },
    };
  }

  touchHeartbeat(state: BotThreadState): BotThreadState {
    if (!state.runStatus.running) return state;
    return {
      ...state,
      runStatus: {
        ...state.runStatus,
        lastHeartbeatAt: new Date().toISOString(),
      },
    };
  }

  finishRun(state: BotThreadState): BotThreadState {
    return {
      ...state,
      runStatus: idleRunStatus(),
    };
  }

  async persistRunState(threadId: string, state: BotThreadState): Promise<void> {
    await setPersistedRunStatus(this.deps.db, threadId, state.runStatus);
  }

  async throwIfCancelled(threadId: string): Promise<void> {
    const status = await getPersistedRunStatus(this.deps.db, threadId);
    if (status?.cancelRequested || status?.stoppedAt) throw new RunCancelledError();
  }

  createHeartbeat(params: {
    thread: Thread<BotThreadState>;
    getState: () => BotThreadState;
    setState: (state: BotThreadState) => void;
    serializeState?: (state: BotThreadState) => BotThreadState;
    intervalMs?: number;
  }) {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const intervalMs = Math.max(500, params.intervalMs ?? RUN_HEARTBEAT_INTERVAL_MS);

    const tick = async () => {
      if (stopped) return;
      try {
        await this.throwIfCancelled(params.thread.id);
      } catch (error) {
        if (error instanceof RunCancelledError) {
          stopped = true;
          if (timer) clearTimeout(timer);
          return;
        }
      }

      try {
        await params.thread.startTyping();
      } catch {
        // noop
      }

      const nextState = await this.recoverState(
        params.thread.id,
        this.touchHeartbeat(params.getState()),
      );
      params.setState(nextState);

      try {
        await params.thread.setState(params.serializeState?.(nextState) ?? nextState, {
          replace: true,
        });
      } catch {
        // noop
      }

      try {
        await this.persistRunState(params.thread.id, nextState);
      } catch {
        // noop
      }

      if (!stopped) timer = setTimeout(() => void tick(), intervalMs);
    };

    return {
      start() {
        if (!timer) timer = setTimeout(() => void tick(), intervalMs);
      },
      stop() {
        stopped = true;
        if (timer) clearTimeout(timer);
      },
    };
  }

  async startWorkflowRun(params: {
    thread: WorkflowThread;
    message: Message;
    state: BotThreadState;
    traceId?: string;
    channelId?: number;
    imageBlocks?: string[];
  }): Promise<string> {
    if (!this.deps.workflow) return "";
    const workflowInstanceId = crypto.randomUUID();
    const workflowState = this.startRun(params.state, workflowInstanceId);
    const instance = await this.deps.workflow.create({
      id: workflowInstanceId,
      params: {
        thread: params.thread.toJSON(),
        message: params.message.toJSON(),
        state: workflowState,
        traceId: params.traceId,
        channelId: params.channelId,
        imageBlocks: params.imageBlocks,
      },
    });
    const nextState = {
      ...params.state,
      runStatus: {
        ...workflowState.runStatus,
        workflowInstanceId: instance.id,
      },
    };
    await params.thread.setState(nextState, { replace: true });
    await this.persistRunState(params.thread.id, nextState);
    await setPersistedWorkflowInstanceId(this.deps.db, params.thread.id, instance.id);
    return instance.id;
  }

  async requestStop(threadId: string, state: BotThreadState) {
    const {
      state: recoveredState,
      runStatus,
      workflowInstanceId,
    } = await this.inspect(threadId, state);
    if (!runStatus.running) {
      return {
        nextState: recoveredState,
        runStatus,
        stopped: false,
      };
    }

    await requestPersistedRunStop(this.deps.db, threadId);
    if (workflowInstanceId && this.deps.workflow) {
      await (await this.deps.workflow.get(workflowInstanceId)).terminate().catch(() => null);
    }
    await clearPersistedWorkflowInstanceId(this.deps.db, threadId);
    const finalized = await finalizePersistedRunStop(this.deps.db, threadId);
    const nextState: BotThreadState = {
      ...recoveredState,
      runStatus: {
        running: false,
        startedAt: null,
        lastHeartbeatAt: null,
        cancelRequested: false,
        cancelRequestedAt: finalized?.cancelRequestedAt ?? runStatus.cancelRequestedAt,
        stoppedAt: finalized?.stoppedAt ?? new Date().toISOString(),
        workflowInstanceId: null,
      },
    };
    await setThreadStateSnapshot(this.deps.db, threadId, nextState);
    return {
      nextState,
      runStatus: nextState.runStatus,
      stopped: true,
    };
  }

  async clearWorkflowInstance(threadId: string): Promise<void> {
    await clearPersistedWorkflowInstanceId(this.deps.db, threadId);
  }

  async getWorkflowStatus(threadId: string, fallbackState: BotThreadState): Promise<string | null> {
    const { workflowInstanceId } = await this.inspect(threadId, fallbackState);
    if (!workflowInstanceId || !this.deps.workflow) return null;
    return (await this.deps.workflow.get(workflowInstanceId))
      .status()
      .then((value: { status: string }) => value.status)
      .catch(() => null);
  }

  async restoreWorkflowState(params: {
    threadId: string;
    state: BotThreadState;
    payloadState?: ConversationWorkflowPayload["state"];
  }): Promise<BotThreadState> {
    const source = params.payloadState as Parameters<typeof normalizeBotThreadState>[0];
    return this.recoverState(params.threadId, normalizeBotThreadState(source ?? params.state));
  }
}

export function idleRunStatus(): RunStatus {
  return {
    running: false,
    startedAt: null,
    lastHeartbeatAt: null,
    cancelRequested: false,
    cancelRequestedAt: null,
    stoppedAt: null,
    workflowInstanceId: null,
  };
}

export function formatBusyState(runStatus: RunStatus): string {
  if (isRunStatusActive(runStatus)) return "yes";
  if (runStatus.running) return "stale";
  return "no";
}

export function isRunBusy(runStatus: RunStatus): boolean {
  return isRunStatusActive(runStatus);
}

export function isRunStatusActive(runStatus: RunStatus): boolean {
  if (!runStatus.running) return false;
  if (!runStatus.lastHeartbeatAt) return false;
  const deltaMs = Date.now() - Date.parse(runStatus.lastHeartbeatAt);
  return Number.isFinite(deltaMs) && deltaMs >= 0 && deltaMs <= RUN_ACTIVE_WINDOW_MS;
}

export function formatElapsedSince(iso: string | null): string {
  if (!iso) return "-";
  const deltaMs = Date.now() - Date.parse(iso);
  if (!Number.isFinite(deltaMs) || deltaMs < 0) return "-";
  const seconds = Math.floor(deltaMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  const remSeconds = seconds % 60;
  return remSeconds ? `${minutes}m ${remSeconds}s ago` : `${minutes}m ago`;
}

export function formatDurationSince(iso: string | null): string {
  if (!iso) return "-";
  const deltaMs = Date.now() - Date.parse(iso);
  if (!Number.isFinite(deltaMs) || deltaMs < 0) return "-";
  const seconds = Math.floor(deltaMs / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remSeconds = seconds % 60;
  return remSeconds ? `${minutes}m ${remSeconds}s` : `${minutes}m`;
}

function withWorkflowInstanceId(
  runStatus: RunStatus,
  workflowInstanceId: string | null,
): RunStatus {
  return {
    ...runStatus,
    workflowInstanceId: workflowInstanceId ?? runStatus.workflowInstanceId ?? null,
  };
}
