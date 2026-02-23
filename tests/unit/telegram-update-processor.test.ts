import { describe, expect, it, vi } from "vitest";
import { processTelegramUpdate } from "../../src/telegram-update-processor";
import type { SessionRequest, SessionResponse } from "../../src/types";
import textMessageFixture from "../fixtures/telegram/text-message.json";
import statusMessageFixture from "../fixtures/telegram/status-message.json";
import resetMessageFixture from "../fixtures/telegram/reset-message.json";
import groupMessageFixture from "../fixtures/telegram/group-message.json";
import unauthorizedMessageFixture from "../fixtures/telegram/unauthorized-message.json";
import photoMessageFixture from "../fixtures/telegram/photo-message.json";

function loadFixture(name: string): unknown {
  if (name === "text-message.json") return textMessageFixture;
  if (name === "status-message.json") return statusMessageFixture;
  if (name === "reset-message.json") return resetMessageFixture;
  if (name === "group-message.json") return groupMessageFixture;
  if (name === "unauthorized-message.json") return unauthorizedMessageFixture;
  if (name === "photo-message.json") return photoMessageFixture;
  throw new Error(`Unknown fixture: ${name}`);
}

function makeDeps() {
  const seen = new Set<number>();
  const sendTyping = vi.fn(async () => {});
  const runSession = vi.fn(async (request: SessionRequest): Promise<SessionResponse> => {
    const text = request.message.text ?? request.message.caption ?? "";
    if (text === "/status") return { ok: true, text: "model: gpt-5.3-codex" };
    if (text === "/reset") return { ok: true, text: "Session reset. Context cleared." };
    return { ok: true, text: `ok:${text || "[image]"}` };
  });

  return {
    runSession,
    sendTyping,
    markUpdateSeen: async (updateId: number) => {
      if (seen.has(updateId)) return false;
      seen.add(updateId);
      return true;
    },
  };
}

describe("processTelegramUpdate", () => {
  it("handles normal text message", async () => {
    const deps = makeDeps();
    const result = await processTelegramUpdate(
      { body: loadFixture("text-message.json"), allowedUserId: "42" },
      deps,
    );

    expect(result.status).toBe("reply");
    if (result.status === "reply") {
      expect(result.reply.chatId).toBe(777);
      expect(result.reply.text).toContain("ok:hello from fixture");
    }
    expect(deps.sendTyping).toHaveBeenCalledTimes(1);
    expect(deps.sendTyping).toHaveBeenCalledWith(777);
    expect(deps.runSession).toHaveBeenCalledTimes(1);
  });

  it("handles /status message", async () => {
    const deps = makeDeps();
    const result = await processTelegramUpdate(
      { body: loadFixture("status-message.json"), allowedUserId: "42" },
      deps,
    );

    expect(result.status).toBe("reply");
    if (result.status === "reply") {
      expect(result.reply.text).toContain("model:");
    }
  });

  it("handles /reset message", async () => {
    const deps = makeDeps();
    const result = await processTelegramUpdate(
      { body: loadFixture("reset-message.json"), allowedUserId: "42" },
      deps,
    );

    expect(result.status).toBe("reply");
    if (result.status === "reply") {
      expect(result.reply.text).toContain("Session reset");
    }
  });

  it("dedupes duplicate update ids", async () => {
    const deps = makeDeps();
    const fixture = loadFixture("text-message.json");

    const first = await processTelegramUpdate({ body: fixture, allowedUserId: "42" }, deps);
    const second = await processTelegramUpdate({ body: fixture, allowedUserId: "42" }, deps);

    expect(first.status).toBe("reply");
    expect(second).toEqual({ status: "ignored", reason: "duplicate_update" });
    expect(deps.sendTyping).toHaveBeenCalledTimes(1);
    expect(deps.runSession).toHaveBeenCalledTimes(1);
  });

  it("ignores non-private and unauthorized users", async () => {
    const deps = makeDeps();

    const nonPrivate = await processTelegramUpdate(
      { body: loadFixture("group-message.json"), allowedUserId: "42" },
      deps,
    );
    const unauthorized = await processTelegramUpdate(
      { body: loadFixture("unauthorized-message.json"), allowedUserId: "42" },
      deps,
    );

    expect(nonPrivate).toEqual({ status: "ignored", reason: "non_private_chat" });
    expect(unauthorized).toEqual({ status: "ignored", reason: "unauthorized_user" });
    expect(deps.sendTyping).toHaveBeenCalledTimes(0);
    expect(deps.runSession).toHaveBeenCalledTimes(0);
  });

  it("accepts photo payload shape and forwards to session", async () => {
    const deps = makeDeps();
    const result = await processTelegramUpdate(
      { body: loadFixture("photo-message.json"), allowedUserId: "42" },
      deps,
    );

    expect(result.status).toBe("reply");
    expect(deps.runSession).toHaveBeenCalledTimes(1);
    const firstCall = deps.runSession.mock.calls[0][0];
    expect(firstCall.message.photo?.length).toBe(2);
    expect(firstCall.message.caption).toBe("photo caption");
  });

  it("continues when typing indicator fails", async () => {
    const deps = makeDeps();
    deps.sendTyping.mockRejectedValueOnce(new Error("network"));

    const result = await processTelegramUpdate(
      { body: loadFixture("text-message.json"), allowedUserId: "42" },
      deps,
    );

    expect(result.status).toBe("reply");
    expect(deps.sendTyping).toHaveBeenCalledTimes(1);
    expect(deps.runSession).toHaveBeenCalledTimes(1);
  });
});
