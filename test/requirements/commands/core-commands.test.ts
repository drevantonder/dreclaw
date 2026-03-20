import { describe, expect, it } from "vite-plus/test";
import { telegramReplyTarget } from "../../../src/app/telegram";
import { buildCommandDeps } from "../../../src/app/deps";
import type { CommandResult } from "../../../src/core/app/types";
import { handleAsyncCommand } from "../../../src/core/commands";
import {
  getPersistedRunStatus,
  getPersistedThreadControls,
  getThreadStateSnapshot,
  setPersistedRunStatus,
  setPersistedThreadControls,
  setThreadStateSnapshot,
} from "../../../src/core/loop/repo";
import { normalizeBotThreadState, THREAD_CONTROL_DEFAULTS } from "../../../src/core/loop/state";
import { createWorkspaceGateway } from "../../../src/core/runtime/adapters/workspace";
import { GOOGLE_OAUTH_DEFAULT_PRINCIPAL } from "../../../src/plugins/google/config";
import { upsertGoogleOAuthToken } from "../../../src/plugins/google/repo";
import type { Env } from "../../../src/cloudflare/env";
import { createEnv } from "../../helpers/fakes";

const THREAD_ID = "telegram:777";
const CHAT_ID = 777;
const ACTOR_ID = "42";

async function runCommand(env: Env, text: string): Promise<CommandResult> {
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

function joined(result: CommandResult): string {
  return result.messages.join("\n");
}

function expectContainsAll(output: string, values: string[]) {
  for (const value of values) expect(output).toContain(value);
}

describe("command requirements", () => {
  it("/help lists the supported command surface", async () => {
    const { env } = createEnv();

    const result = await runCommand(env, "/help");
    const output = joined(result);

    expectContainsAll(output, [
      "Commands:",
      "/help",
      "/status",
      "/model",
      "/new",
      "/reset",
      "/factory-reset",
      "/stop",
      "/verbose on|off",
      "/thinking on|off",
      "/reasoning on|off",
      "/google connect",
      "/google status",
      "/google disconnect",
    ]);
  });

  it("/status returns the required status fields", async () => {
    const { env } = createEnv();

    const result = await runCommand(env, "/status");
    const output = joined(result);

    expectContainsAll(output, [
      "model:",
      "provider:",
      "busy:",
      "verbose:",
      "thinking:",
      "reasoning:",
      "thread:",
    ]);
  });

  it("/model reports current alias, target, and aliases", async () => {
    const { env } = createEnv();

    const result = await runCommand(env, "/model");
    const output = joined(result);

    expectContainsAll(output, ["current:", "target:", "aliases:"]);
  });

  it("/model <alias> persists the alias and acknowledges the change", async () => {
    const { env } = createEnv();

    const result = await runCommand(env, "/model kimi");
    const output = joined(result);
    const controls = await getPersistedThreadControls(env.DRECLAW_DB, THREAD_ID);
    const snapshot = await getThreadStateSnapshot<ReturnType<typeof normalizeBotThreadState>>(
      env.DRECLAW_DB,
      THREAD_ID,
    );

    expectContainsAll(output, ["model set: kimi", "current: kimi", "target:", "aliases:"]);
    expect(controls).toEqual({
      verbose: THREAD_CONTROL_DEFAULTS.verbose,
      thinking: THREAD_CONTROL_DEFAULTS.thinking,
      reasoning: THREAD_CONTROL_DEFAULTS.reasoning,
      modelAlias: "kimi",
    });
    expect(snapshot?.modelAlias).toBe("kimi");
  });

  it("/model rejects unknown aliases with recovery context", async () => {
    const { env } = createEnv();

    const result = await runCommand(env, "/model nope");
    const output = joined(result);

    expectContainsAll(output, ["unknown model alias: nope", "current:", "aliases:", "usage:"]);
  });

  it("/new clears session context but preserves thread settings", async () => {
    const { env } = createEnv();
    await setPersistedThreadControls(env.DRECLAW_DB, THREAD_ID, {
      verbose: true,
      thinking: false,
      reasoning: true,
      modelAlias: "kimi",
    });
    await setThreadStateSnapshot(env.DRECLAW_DB, THREAD_ID, {
      ...normalizeBotThreadState(undefined),
      history: [
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
      ],
      verbose: true,
      thinking: false,
      reasoning: true,
      modelAlias: "kimi",
      runStatus: {
        running: true,
        startedAt: "2026-03-20T00:00:00.000Z",
        lastHeartbeatAt: "2026-03-20T00:00:01.000Z",
        cancelRequested: false,
        cancelRequestedAt: null,
        stoppedAt: null,
        workflowInstanceId: null,
      },
    });

    const result = await runCommand(env, "/new");
    const snapshot = await getThreadStateSnapshot<ReturnType<typeof normalizeBotThreadState>>(
      env.DRECLAW_DB,
      THREAD_ID,
    );
    const controls = await getPersistedThreadControls(env.DRECLAW_DB, THREAD_ID);

    expect(joined(result)).toContain("New session started.");
    expect(snapshot?.history).toEqual([]);
    expect(snapshot?.runStatus.running).toBe(false);
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

  it("/reset clears session context and restores chat defaults while preserving the model alias", async () => {
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

    const result = await runCommand(env, "/reset");
    const snapshot = await getThreadStateSnapshot<ReturnType<typeof normalizeBotThreadState>>(
      env.DRECLAW_DB,
      THREAD_ID,
    );
    const controls = await getPersistedThreadControls(env.DRECLAW_DB, THREAD_ID);

    expect(joined(result)).toContain("chat defaults restored");
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

  it("/factory-reset clears workspace files and thread controls", async () => {
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
    await backend.writeFile("/tmp/requirement-reset.txt", "hello");

    const result = await runCommand(env, "/factory-reset");
    const snapshot = await getThreadStateSnapshot<ReturnType<typeof normalizeBotThreadState>>(
      env.DRECLAW_DB,
      THREAD_ID,
    );
    const controls = await getPersistedThreadControls(env.DRECLAW_DB, THREAD_ID);

    expect(joined(result)).toContain("Factory reset complete.");
    expect(await backend.exists("/tmp/requirement-reset.txt")).toBe(false);
    expect(snapshot?.history).toEqual([]);
    expect(snapshot?.modelAlias).toBe(null);
    expect(controls).toEqual({
      verbose: THREAD_CONTROL_DEFAULTS.verbose,
      thinking: THREAD_CONTROL_DEFAULTS.thinking,
      reasoning: THREAD_CONTROL_DEFAULTS.reasoning,
      modelAlias: null,
    });
  });

  it("/stop reports idle and stops an active run", async () => {
    const { env } = createEnv();

    const idle = await runCommand(env, "/stop");
    expect(joined(idle)).toContain("Nothing is running.");

    await setPersistedRunStatus(env.DRECLAW_DB, THREAD_ID, {
      running: true,
      startedAt: new Date().toISOString(),
      lastHeartbeatAt: new Date().toISOString(),
      cancelRequested: false,
      cancelRequestedAt: null,
      stoppedAt: null,
      workflowInstanceId: null,
    });

    const active = await runCommand(env, "/stop");
    const runStatus = await getPersistedRunStatus(env.DRECLAW_DB, THREAD_ID);

    expect(joined(active)).toContain("Stopped.");
    expect(runStatus?.running).toBe(false);
  });

  it("control commands report current state plus usage when called without a value", async () => {
    const { env } = createEnv();
    await setPersistedThreadControls(env.DRECLAW_DB, THREAD_ID, {
      verbose: true,
      thinking: false,
      reasoning: true,
      modelAlias: null,
    });

    const verbose = joined(await runCommand(env, "/verbose"));
    const thinking = joined(await runCommand(env, "/thinking"));
    const reasoning = joined(await runCommand(env, "/reasoning"));

    expect(verbose).toContain("verbose: on");
    expect(verbose).toContain("usage: /verbose on|off");
    expect(thinking).toContain("thinking: off");
    expect(thinking).toContain("usage: /thinking on|off");
    expect(reasoning).toContain("reasoning: on");
    expect(reasoning).toContain("usage: /reasoning on|off");
  });

  it("control commands persist on/off transitions and acknowledge them", async () => {
    const { env } = createEnv();

    expect(joined(await runCommand(env, "/verbose on"))).toContain("verbose enabled.");
    expect(joined(await runCommand(env, "/thinking off"))).toContain("thinking disabled.");
    expect(joined(await runCommand(env, "/reasoning on"))).toContain("reasoning enabled.");

    const controls = await getPersistedThreadControls(env.DRECLAW_DB, THREAD_ID);
    expect(controls).toEqual({
      verbose: true,
      thinking: false,
      reasoning: true,
      modelAlias: null,
    });
  });

  it("google commands cover help, connect, status, and disconnect", async () => {
    const { env, db } = createEnv();

    const help = joined(await runCommand(env, "/google help"));
    expectContainsAll(help, ["/google connect", "/google status", "/google disconnect"]);

    const connect = joined(await runCommand(env, "/google connect"));
    expect(connect).toContain("https://");
    expect(db.oauthStates.size).toBe(1);

    const statusBefore = joined(await runCommand(env, "/google status"));
    expect(statusBefore).toContain("google: not linked");

    await upsertGoogleOAuthToken(env.DRECLAW_DB, {
      principal: GOOGLE_OAUTH_DEFAULT_PRINCIPAL,
      telegramUserId: CHAT_ID,
      refreshTokenCiphertext: "cipher",
      nonce: "nonce",
      scopes: "scope-a scope-b",
      updatedAt: "2026-03-20T00:00:00.000Z",
    });

    const statusAfter = joined(await runCommand(env, "/google status"));
    expectContainsAll(statusAfter, ["google: linked", "scope-a scope-b"]);

    const disconnect = joined(await runCommand(env, "/google disconnect"));
    expect(disconnect).toContain("disconnected");

    const disconnectAgain = joined(await runCommand(env, "/google disconnect"));
    expect(disconnectAgain).toContain("No linked Google account found.");
  });

  it("busy-sensitive commands refuse to run while the thread is busy", async () => {
    const { env, db } = createEnv();
    await setPersistedThreadControls(env.DRECLAW_DB, THREAD_ID, {
      verbose: true,
      thinking: false,
      reasoning: true,
      modelAlias: "kimi",
    });
    await setThreadStateSnapshot(env.DRECLAW_DB, THREAD_ID, {
      ...normalizeBotThreadState(undefined),
      history: [
        { role: "user", content: "keep this context" },
        { role: "assistant", content: "still here" },
      ],
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
    await backend.writeFile("/tmp/requirement-busy-reset.txt", "hello");
    await setPersistedRunStatus(env.DRECLAW_DB, THREAD_ID, {
      running: true,
      startedAt: "2026-03-20T10:00:00.000Z",
      lastHeartbeatAt: new Date().toISOString(),
      cancelRequested: false,
      cancelRequestedAt: null,
      stoppedAt: null,
      workflowInstanceId: null,
    });

    expect(joined(await runCommand(env, "/model workers-kimi"))).toContain(
      "Currently busy. Not executed.",
    );
    expect(joined(await runCommand(env, "/new"))).toContain("Currently busy. Not executed.");
    expect(joined(await runCommand(env, "/reset"))).toContain("Currently busy. Not executed.");
    expect(joined(await runCommand(env, "/factory-reset"))).toContain(
      "Currently busy. Not executed.",
    );
    expect(joined(await runCommand(env, "/google connect"))).toContain(
      "Currently busy. Not executed.",
    );

    const controls = await getPersistedThreadControls(env.DRECLAW_DB, THREAD_ID);
    const snapshot = await getThreadStateSnapshot<ReturnType<typeof normalizeBotThreadState>>(
      env.DRECLAW_DB,
      THREAD_ID,
    );

    expect(controls).toEqual({
      verbose: true,
      thinking: false,
      reasoning: true,
      modelAlias: "kimi",
    });
    expect(snapshot?.history).toEqual([
      { role: "user", content: "keep this context" },
      { role: "assistant", content: "still here" },
    ]);
    expect(snapshot?.modelAlias).toBe("kimi");
    expect(await backend.exists("/tmp/requirement-busy-reset.txt")).toBe(true);
    expect(db.oauthStates.size).toBe(0);
  });
});
