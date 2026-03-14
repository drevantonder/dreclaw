import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { createEnv } from "../helpers/fakes";

const mocks = vi.hoisted(() => {
  const runtimeInstance = {
    help: vi.fn(() => "help text"),
    status: vi.fn(async () => "status text"),
    reset: vi.fn((state) => ({ ...state, history: [] })),
    setVerbose: vi.fn((state, enabled) => ({ ...state, verbose: enabled })),
    factoryReset: vi.fn(async () => ({ history: [], verbose: false, runStatus: {} })),
    handleGoogleCommand: vi.fn(async () => "google text"),
  };
  class BotRuntimeMock {
    constructor(_env: unknown, _executionContext?: unknown) {}

    help = runtimeInstance.help;
    status = runtimeInstance.status;
    reset = runtimeInstance.reset;
    setVerbose = runtimeInstance.setVerbose;
    factoryReset = runtimeInstance.factoryReset;
    handleGoogleCommand = runtimeInstance.handleGoogleCommand;
  }
  return {
    runtimeInstance,
    BotRuntime: vi.fn(BotRuntimeMock),
    sendTelegramTextMessage: vi.fn(),
    getThreadStateSnapshot: vi.fn(),
    setPersistedThreadControls: vi.fn(),
    setThreadStateSnapshot: vi.fn(),
    createRunCoordinator: vi.fn(),
  };
});

vi.mock("../../src/core/loop/runtime", () => ({
  BotRuntime: mocks.BotRuntime,
}));

vi.mock("../../src/chat-adapters/telegram/api", () => ({
  sendTelegramTextMessage: mocks.sendTelegramTextMessage,
}));

vi.mock("../../src/db", () => ({
  getThreadStateSnapshot: mocks.getThreadStateSnapshot,
  setPersistedThreadControls: mocks.setPersistedThreadControls,
  setThreadStateSnapshot: mocks.setThreadStateSnapshot,
}));

vi.mock("../../src/core/loop/run", () => ({
  createRunCoordinator: mocks.createRunCoordinator,
}));

import {
  handleAsyncCommand,
  maybeHandleAsyncTelegramCommand,
} from "../../src/chat-adapters/telegram/commands";

describe("telegram commands", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getThreadStateSnapshot.mockResolvedValue({
      history: ["old"],
      verbose: false,
      runStatus: { running: false },
    });
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
    expect(mocks.BotRuntime).not.toHaveBeenCalled();
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
    expect(mocks.BotRuntime).toHaveBeenCalled();
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
      runStatus: { running: false },
    });

    await handleAsyncCommand({
      env,
      runtime: mocks.runtimeInstance as never,
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
      runtime: mocks.runtimeInstance as never,
      threadId: "telegram:777",
      chatId: 777,
      telegramUserId: 42,
      text: "/google connect",
    });

    expect(mocks.runtimeInstance.handleGoogleCommand).not.toHaveBeenCalled();
    expect(mocks.sendTelegramTextMessage).toHaveBeenCalledWith(
      env.TELEGRAM_BOT_TOKEN,
      777,
      "Currently busy. Not executed. Run /google connect again when not busy.",
    );
  });
});
