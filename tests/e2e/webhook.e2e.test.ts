import { describe, expect, it, vi } from "vitest";
import worker from "../../src/index";
import { createEnv } from "../helpers/fakes";

const app = worker as unknown as {
  fetch(request: Request, env: unknown, ctx: ExecutionContext): Promise<Response>;
};

function makeUpdate(updateId: number, text: string, userId = 42) {
  return {
    update_id: updateId,
    message: {
      message_id: 1,
      date: 170000,
      chat: { id: 777, type: "private" },
      from: { id: userId },
      text,
    },
  };
}

describe("telegram webhook e2e", () => {
  it("executes webhook -> session -> telegram send", async () => {
    const { env, db } = createEnv();
    const sends: Array<{ url: string; body: unknown }> = [];
    const actions: Array<{ url: string; body: unknown }> = [];
    const timeline: string[] = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/sendChatAction")) {
          timeline.push("typing");
          actions.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        if (url.includes("/sendMessage")) {
          timeline.push("message");
          sends.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        return new Response("{}", { status: 200 });
      }),
    );

    const req = new Request("https://test.local/telegram/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": env.TELEGRAM_WEBHOOK_SECRET,
      },
      body: JSON.stringify(makeUpdate(1001, "/status")),
    });

    const res = await app.fetch(req, env, {} as ExecutionContext);
    expect(res.status).toBe(200);
    expect(db.updates.has(1001)).toBe(true);
    expect(actions.length).toBe(1);
    expect(sends.length).toBe(1);
    expect(timeline).toEqual(["typing", "message"]);
    const action = actions[0].body as { action: string };
    expect(action.action).toBe("typing");
    const sent = sends[0].body as { text: string; parse_mode?: string };
    expect(sent.parse_mode).toBe("HTML");
    expect(sent.text).toContain("model:");
    expect(sent.text).toContain("provider_auth:");
    expect(sent.text).toContain("memory_enabled:");
  });

  it("ignores duplicate update id", async () => {
    const { env } = createEnv();
    const sends: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes("/sendMessage")) sends.push(url);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }),
    );

    const headers = {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": env.TELEGRAM_WEBHOOK_SECRET,
    };
    const body = JSON.stringify(makeUpdate(1002, "/status"));

    await app.fetch(new Request("https://test.local/telegram/webhook", { method: "POST", headers, body }), env, {} as ExecutionContext);
    await app.fetch(new Request("https://test.local/telegram/webhook", { method: "POST", headers, body }), env, {} as ExecutionContext);

    expect(sends.length).toBe(1);
  });

  it("rejects invalid webhook secret", async () => {
    const { env } = createEnv();
    const sendMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", sendMock);

    const res = await app.fetch(
      new Request("https://test.local/telegram/webhook", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-telegram-bot-api-secret-token": "bad",
        },
        body: JSON.stringify(makeUpdate(1003, "hello")),
      }),
      env,
      {} as ExecutionContext,
    );

    expect(res.status).toBe(401);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("rejects non-json webhook payloads", async () => {
    const { env } = createEnv();
    const sendMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", sendMock);

    const res = await app.fetch(
      new Request("https://test.local/telegram/webhook", {
        method: "POST",
        headers: {
          "content-type": "text/plain",
          "x-telegram-bot-api-secret-token": env.TELEGRAM_WEBHOOK_SECRET,
        },
        body: "hi",
      }),
      env,
      {} as ExecutionContext,
    );

    expect(res.status).toBe(415);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("rejects malformed json payload", async () => {
    const { env } = createEnv();
    const sendMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", sendMock);

    const res = await app.fetch(
      new Request("https://test.local/telegram/webhook", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-telegram-bot-api-secret-token": env.TELEGRAM_WEBHOOK_SECRET,
        },
        body: "{bad",
      }),
      env,
      {} as ExecutionContext,
    );

    expect(res.status).toBe(400);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("rejects oversized payload", async () => {
    const { env } = createEnv();
    const sendMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", sendMock);

    const res = await app.fetch(
      new Request("https://test.local/telegram/webhook", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-telegram-bot-api-secret-token": env.TELEGRAM_WEBHOOK_SECRET,
        },
        body: "x".repeat(256_001),
      }),
      env,
      {} as ExecutionContext,
    );

    expect(res.status).toBe(413);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("handles google oauth callback and stores encrypted refresh token", async () => {
    const { env, db } = createEnv();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/sendChatAction") || url.includes("/sendMessage")) {
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        }
        if (url === "https://oauth2.googleapis.com/token") {
          const body = String(init?.body ?? "");
          if (body.includes("grant_type=authorization_code")) {
            return new Response(
              JSON.stringify({
                access_token: "access-token",
                refresh_token: "refresh-token",
                scope: "scope-a scope-b",
                expires_in: 3600,
                token_type: "Bearer",
              }),
              { status: 200 },
            );
          }
        }
        return new Response("{}", { status: 200 });
      }),
    );

    const webhookReq = new Request("https://test.local/telegram/webhook", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": env.TELEGRAM_WEBHOOK_SECRET,
      },
      body: JSON.stringify(makeUpdate(1004, "/google connect")),
    });
    const webhookRes = await app.fetch(webhookReq, env, {} as ExecutionContext);
    expect(webhookRes.status).toBe(200);

    const state = [...db.oauthStates.keys()][0];
    expect(state).toBeTruthy();

    const callbackReq = new Request(`https://test.local/google/oauth/callback?state=${state}&code=good-code`, {
      method: "GET",
    });
    const callbackRes = await app.fetch(callbackReq, env, {} as ExecutionContext);
    expect(callbackRes.status).toBe(200);
    expect(db.oauthTokens.has("default")).toBe(true);
  });

  it("rejects google oauth callback with unknown state", async () => {
    const { env } = createEnv();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })));

    const callbackReq = new Request("https://test.local/google/oauth/callback?state=missing&code=bad", { method: "GET" });
    const callbackRes = await app.fetch(callbackReq, env, {} as ExecutionContext);
    expect(callbackRes.status).toBe(400);
    const text = await callbackRes.text();
    expect(text).toContain("Invalid or expired state");
  });
});
