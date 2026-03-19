import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createEnv } from "../../helpers/fakes";

const mocks = vi.hoisted(() => {
  const controlsInstance = {
    help: vi.fn(() => "help text"),
    status: vi.fn(async () => "status text"),
    reset: vi.fn((state) => ({ ...state, history: [] })),
    setVerbose: vi.fn((state, enabled) => ({ ...state, verbose: enabled })),
    factoryReset: vi.fn(async () => ({ history: [], verbose: false, runStatus: {} })),
  };
  return {
    controlsInstance,
    createLoopServices: vi.fn(() => ({
      controls: controlsInstance,
      conversation: {},
      wake: {},
    })),
    sendTelegramTextMessage: vi.fn(),
    getPersistedThreadControls: vi.fn(),
    getThreadStateSnapshot: vi.fn(),
    setPersistedThreadControls: vi.fn(),
    setThreadStateSnapshot: vi.fn(),
    createRunCoordinator: vi.fn(),
  };
});

vi.mock("../../../src/core/runtime", () => ({
  createLoopServices: mocks.createLoopServices,
}));

vi.mock("../../../src/chat-adapters/telegram/api", () => ({
  sendTelegramTextMessage: mocks.sendTelegramTextMessage,
}));

vi.mock("../../../src/core/loop/repo", () => ({
  getPersistedThreadControls: mocks.getPersistedThreadControls,
  getThreadStateSnapshot: mocks.getThreadStateSnapshot,
  setPersistedThreadControls: mocks.setPersistedThreadControls,
  setThreadStateSnapshot: mocks.setThreadStateSnapshot,
}));

vi.mock("../../../src/core/loop/run", () => ({
  createRunCoordinator: mocks.createRunCoordinator,
}));

import {
  handleAsyncCommand,
  maybeHandleAsyncTelegramCommand,
} from "../../../src/chat-adapters/telegram/commands";

describe("telegram commands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getThreadStateSnapshot.mockResolvedValue({
      history: ["old"],
      verbose: false,
      modelAlias: null,
      runStatus: { running: false },
    });
    mocks.getPersistedThreadControls.mockResolvedValue({ verbose: false, modelAlias: null });
    mocks.createRunCoordinator.mockReturnValue({
      recoverState: vi.fn(async (_threadId: string, state: unknown) => state),
      getStatus: vi.fn(async () => ({ busy: "no", runStatus: { running: false } })),
      getWorkflowStatus: vi.fn(async () => null),
      requestStop: vi.fn(async () => undefined),
    });
    mocks.sendTelegramTextMessage.mockResolvedValue(undefined);
  });

  it("returns false for non-command updates", async () => {
    const { env } = createEnv();

    const handled = await maybeHandleAsyncTelegramCommand(env, {
      update_id: 1,
      message: {
        message_id: 1,
        date: 1,
        text: "hello",
        chat: { id: 777, type: "private" },
        from: { id: 42 },
      },
    });

    expect(handled).toBe(false);
    expect(mocks.createLoopServices).not.toHaveBeenCalled();
    expect(mocks.sendTelegramTextMessage).not.toHaveBeenCalled();
  });

  it("handles help commands through the runtime boundary", async () => {
    const { env } = createEnv();

    const handled = await maybeHandleAsyncTelegramCommand(env, {
      update_id: 2,
      message: {
        message_id: 2,
        date: 1,
        text: "/help",
        chat: { id: 777, type: "private" },
        from: { id: 42 },
      },
    });

    expect(handled).toBe(true);
    expect(mocks.createLoopServices).toHaveBeenCalled();
    expect(mocks.sendTelegramTextMessage).toHaveBeenCalledWith(
      env.TELEGRAM_BOT_TOKEN,
      777,
      "help text",
    );
  });

  it("reports verbose usage when the flag value is invalid", async () => {
    const { env } = createEnv();
    mocks.getThreadStateSnapshot.mockResolvedValue({
      history: [],
      verbose: true,
      modelAlias: null,
      runStatus: { running: false },
    });

    await handleAsyncCommand({
      env,
      controls: mocks.controlsInstance as never,
      threadId: "telegram:777",
      chatId: 777,
      telegramUserId: 42,
      text: "/verbose maybe",
    });

    expect(mocks.sendTelegramTextMessage).toHaveBeenCalledWith(
      env.TELEGRAM_BOT_TOKEN,
      777,
      "verbose: on\nusage: /verbose on|off",
    );
  });

  it("blocks busy google connect commands", async () => {
    const { env } = createEnv();
    mocks.createRunCoordinator.mockReturnValue({
      recoverState: vi.fn(async (_threadId: string, state: unknown) => state),
      getStatus: vi.fn(async () => ({ busy: "yes", runStatus: { running: true } })),
      getWorkflowStatus: vi.fn(async () => null),
      requestStop: vi.fn(async () => undefined),
    });

    await handleAsyncCommand({
      env,
      controls: mocks.controlsInstance as never,
      threadId: "telegram:777",
      chatId: 777,
      telegramUserId: 42,
      text: "/google connect",
    });

    expect(mocks.sendTelegramTextMessage).toHaveBeenCalledWith(
      env.TELEGRAM_BOT_TOKEN,
      777,
      "Currently busy. Not executed. Run /google connect again when not busy.",
    );
  });

  it("shows current model aliases", async () => {
    const { env } = createEnv();

    await handleAsyncCommand({
      env,
      controls: mocks.controlsInstance as never,
      threadId: "telegram:777",
      chatId: 777,
      telegramUserId: 42,
      text: "/model",
    });

    expect(mocks.sendTelegramTextMessage).toHaveBeenCalledWith(
      env.TELEGRAM_BOT_TOKEN,
      777,
      expect.stringContaining("current: glm"),
    );
    expect(mocks.sendTelegramTextMessage).toHaveBeenCalledWith(
      env.TELEGRAM_BOT_TOKEN,
      777,
      expect.stringContaining(
        "aliases: glm, workers-kimi, kimi, fireworks-kimi, fireworks-minimax",
      ),
    );
  });

  it("persists model alias for the thread", async () => {
    const { env } = createEnv();

    await handleAsyncCommand({
      env,
      controls: mocks.controlsInstance as never,
      threadId: "telegram:777",
      chatId: 777,
      telegramUserId: 42,
      text: "/model kimi",
    });

    expect(mocks.setPersistedThreadControls).toHaveBeenCalledWith(env.DRECLAW_DB, "telegram:777", {
      verbose: false,
      modelAlias: "kimi",
    });
    expect(mocks.setThreadStateSnapshot).toHaveBeenCalledWith(env.DRECLAW_DB, "telegram:777", {
      history: [],
      memoryTurns: 0,
      verbose: false,
      modelAlias: "kimi",
      codeRuntime: {},
      loadedSkills: [],
      runStatus: {
        running: false,
        startedAt: null,
        lastHeartbeatAt: null,
        cancelRequested: false,
        cancelRequestedAt: null,
        stoppedAt: null,
        workflowInstanceId: null,
      },
    });
    expect(mocks.sendTelegramTextMessage).toHaveBeenCalledWith(
      env.TELEGRAM_BOT_TOKEN,
      777,
      expect.stringContaining("model set: kimi"),
    );
  });

  it("clears saved model alias on factory reset", async () => {
    const { env } = createEnv();
    mocks.getPersistedThreadControls.mockResolvedValue({ verbose: true, modelAlias: "kimi" });
    mocks.controlsInstance.factoryReset.mockResolvedValue({
      history: [],
      verbose: false,
      modelAlias: null,
      runStatus: {},
    } as never);

    await handleAsyncCommand({
      env,
      controls: mocks.controlsInstance as never,
      threadId: "telegram:777",
      chatId: 777,
      telegramUserId: 42,
      text: "/factory-reset",
    });

    expect(mocks.setPersistedThreadControls).toHaveBeenCalledWith(env.DRECLAW_DB, "telegram:777", {
      verbose: false,
      modelAlias: null,
    });
  });
});
