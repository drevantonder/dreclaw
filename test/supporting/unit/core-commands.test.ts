import { describe, expect, it } from "vite-plus/test";
import { buildCommandDeps } from "../../../src/app/deps";
import { telegramReplyTarget } from "../../../src/app/telegram";
import { handleAsyncCommand } from "../../../src/core/commands";
import {
  getPersistedThreadControls,
  getThreadStateSnapshot,
  setPersistedThreadControls,
  setThreadStateSnapshot,
} from "../../../src/core/loop/repo";
import { normalizeBotThreadState, THREAD_CONTROL_DEFAULTS } from "../../../src/core/loop/state";
import { createWorkspaceGateway } from "../../../src/core/runtime/adapters/workspace";
import type { Env } from "../../../src/cloudflare/env";
import { createEnv } from "../../helpers/fakes";

const THREAD_ID = "telegram:777";
const CHAT_ID = 777;
const ACTOR_ID = "42";

async function runCommand(env: Env, text: string) {
  return handleAsyncCommand({
    deps: buildCommandDeps(env),
    input: {
      threadId: THREAD_ID,
      actorId: ACTOR_ID,
      channelId: CHAT_ID,
      replyTarget: telegramReplyTarget(CHAT_ID),
      text,
    },
  });
}

describe("core commands supporting coverage", () => {
  it("persists the selected model alias into controls and thread state", async () => {
    const { env } = createEnv();

    const result = await runCommand(env, "/model kimi");
    const controls = await getPersistedThreadControls(env.DRECLAW_DB, THREAD_ID);
    const snapshot = await getThreadStateSnapshot<ReturnType<typeof normalizeBotThreadState>>(
      env.DRECLAW_DB,
      THREAD_ID,
    );

    expect(result.messages.join("\n")).toContain("model set: kimi");
    expect(controls?.modelAlias).toBe("kimi");
    expect(snapshot?.modelAlias).toBe("kimi");
  });

  it("clears history on /new while preserving thread settings", async () => {
    const { env } = createEnv();
    await setPersistedThreadControls(env.DRECLAW_DB, THREAD_ID, {
      verbose: true,
      thinking: false,
      reasoning: true,
      modelAlias: "kimi",
    });
    await setThreadStateSnapshot(env.DRECLAW_DB, THREAD_ID, {
      ...normalizeBotThreadState(undefined),
      history: [{ role: "user", content: "hello" }],
      verbose: true,
      thinking: false,
      reasoning: true,
      modelAlias: "kimi",
    });

    await runCommand(env, "/new");

    const controls = await getPersistedThreadControls(env.DRECLAW_DB, THREAD_ID);
    const snapshot = await getThreadStateSnapshot<ReturnType<typeof normalizeBotThreadState>>(
      env.DRECLAW_DB,
      THREAD_ID,
    );

    expect(snapshot?.history).toEqual([]);
    expect(snapshot?.verbose).toBe(true);
    expect(snapshot?.thinking).toBe(false);
    expect(snapshot?.reasoning).toBe(true);
    expect(snapshot?.modelAlias).toBe("kimi");
    expect(controls).toEqual({
      verbose: true,
      thinking: false,
      reasoning: true,
      modelAlias: "kimi",
    });
  });

  it("restores defaults on /reset while preserving the selected model alias", async () => {
    const { env } = createEnv();
    await setPersistedThreadControls(env.DRECLAW_DB, THREAD_ID, {
      verbose: true,
      thinking: false,
      reasoning: true,
      modelAlias: "kimi",
    });
    await setThreadStateSnapshot(env.DRECLAW_DB, THREAD_ID, {
      ...normalizeBotThreadState(undefined),
      history: [{ role: "user", content: "hello" }],
      verbose: true,
      thinking: false,
      reasoning: true,
      modelAlias: "kimi",
    });

    await runCommand(env, "/reset");

    const controls = await getPersistedThreadControls(env.DRECLAW_DB, THREAD_ID);
    const snapshot = await getThreadStateSnapshot<ReturnType<typeof normalizeBotThreadState>>(
      env.DRECLAW_DB,
      THREAD_ID,
    );

    expect(snapshot?.history).toEqual([]);
    expect(snapshot?.verbose).toBe(THREAD_CONTROL_DEFAULTS.verbose);
    expect(snapshot?.thinking).toBe(THREAD_CONTROL_DEFAULTS.thinking);
    expect(snapshot?.reasoning).toBe(THREAD_CONTROL_DEFAULTS.reasoning);
    expect(snapshot?.modelAlias).toBe("kimi");
    expect(controls).toEqual({
      verbose: THREAD_CONTROL_DEFAULTS.verbose,
      thinking: THREAD_CONTROL_DEFAULTS.thinking,
      reasoning: THREAD_CONTROL_DEFAULTS.reasoning,
      modelAlias: "kimi",
    });
  });

  it("clears workspace state and resets persisted controls on /factory-reset", async () => {
    const { env } = createEnv();
    await setPersistedThreadControls(env.DRECLAW_DB, THREAD_ID, {
      verbose: true,
      thinking: false,
      reasoning: true,
      modelAlias: "kimi",
    });
    const workspace = createWorkspaceGateway({
      db: env.DRECLAW_DB,
      maxFileBytes: 10_000,
      maxPathLength: 255,
    });
    const backend = workspace.createStateBackend();
    await backend.writeFile("/tmp/supporting-reset.txt", "hello");

    await runCommand(env, "/factory-reset");

    const controls = await getPersistedThreadControls(env.DRECLAW_DB, THREAD_ID);
    const snapshot = await getThreadStateSnapshot<ReturnType<typeof normalizeBotThreadState>>(
      env.DRECLAW_DB,
      THREAD_ID,
    );

    expect(await backend.exists("/tmp/supporting-reset.txt")).toBe(false);
    expect(snapshot?.history).toEqual([]);
    expect(snapshot?.modelAlias).toBe(null);
    expect(controls).toEqual({
      verbose: THREAD_CONTROL_DEFAULTS.verbose,
      thinking: THREAD_CONTROL_DEFAULTS.thinking,
      reasoning: THREAD_CONTROL_DEFAULTS.reasoning,
      modelAlias: null,
    });
  });
});
