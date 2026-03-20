import { vi } from "vite-plus/test";
import worker from "../../src/cloudflare/index";
import type { Env } from "../../src/cloudflare/env";
import { createEnv, waitForWorkflowTasks } from "./fakes";

const app = worker as unknown as {
  fetch(request: Request, env: unknown, ctx: ExecutionContext): Promise<Response>;
};

export type TelegramTransportCall = {
  method: string;
  text: string;
};

function createExecutionTracker() {
  const pending: Promise<unknown>[] = [];
  return {
    ctx: {
      waitUntil(task: Promise<unknown>) {
        pending.push(task);
      },
      passThroughOnException() {
        return;
      },
      props: {},
    } as unknown as ExecutionContext,
    async wait() {
      await Promise.allSettled(pending.splice(0));
      await waitForWorkflowTasks();
    },
  };
}

function telegramMessageResult(text: string, messageId: number) {
  return {
    ok: true,
    result: {
      message_id: messageId,
      date: 170000,
      text,
      chat: { id: 777, type: "private" },
      from: { id: 999, is_bot: true, username: "dreclawbot", first_name: "dreclaw" },
    },
  };
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function requestJsonBody(init?: RequestInit): { text?: string } {
  const body = init?.body;
  if (typeof body !== "string") return {};
  return JSON.parse(body) as { text?: string };
}

function makeUpdate(updateId: number, text?: string) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: 170000,
      chat: { id: 777, type: "private" },
      from: { id: 42, is_bot: false, username: "andre", first_name: "Andre" },
      ...(text !== undefined ? { text } : {}),
    },
  };
}

function makeWebhookRequest(secret: string, updateId: number, text?: string) {
  return new Request("https://test.local/telegram/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": secret,
    },
    body: JSON.stringify(makeUpdate(updateId, text)),
  });
}

export function createAssistantHarness(options?: {
  envOverrides?: Partial<Env>;
  draftUnsupported?: boolean;
  nowStepMs?: number;
}) {
  const { env, db } = createEnv(options?.envOverrides);
  const tracker = createExecutionTracker();
  const calls: TelegramTransportCall[] = [];
  let updateId = 1;
  let messageId = 100;
  if ((options?.nowStepMs ?? 0) > 0) {
    let clock = 0;
    vi.spyOn(Date, "now").mockImplementation(() => {
      clock += options?.nowStepMs ?? 0;
      return clock;
    });
  }

  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input);
      if (url.includes("/getMe")) {
        return new Response(
          JSON.stringify({ ok: true, result: { id: 999, is_bot: true, username: "dreclawbot" } }),
          { status: 200 },
        );
      }
      if (url.includes("/getWebhookInfo")) {
        return new Response(
          JSON.stringify({ ok: true, result: { url: "https://test.local/telegram/webhook" } }),
          { status: 200 },
        );
      }
      if (url.includes("/sendChatAction")) {
        return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
      }
      if (url.includes("/sendMessageDraft")) {
        const body = requestJsonBody(init);
        calls.push({ method: "sendMessageDraft", text: body.text ?? "" });
        if (options?.draftUnsupported) {
          return new Response(JSON.stringify({ ok: false, description: "method not found" }), {
            status: 404,
          });
        }
        return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
      }
      if (url.includes("/sendMessage")) {
        const body = requestJsonBody(init);
        calls.push({ method: "sendMessage", text: body.text ?? "" });
        return new Response(JSON.stringify(telegramMessageResult(body.text ?? "", messageId++)), {
          status: 200,
        });
      }
      if (url.includes("/editMessageText")) {
        const body = requestJsonBody(init);
        calls.push({ method: "editMessageText", text: body.text ?? "" });
        return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }),
  );

  const nonReasoningTexts = () =>
    calls.map((call) => call.text).filter((text) => text && !text.startsWith("Reasoning:\n"));

  return {
    env,
    db,
    calls,
    async send(text: string) {
      const response = await app.fetch(
        makeWebhookRequest(env.TELEGRAM_WEBHOOK_SECRET, updateId++, text) as unknown as Request,
        env,
        tracker.ctx,
      );
      await tracker.wait();
      return response;
    },
    clearCalls() {
      calls.splice(0);
    },
    visibleTexts() {
      return calls.map((call) => call.text);
    },
    reasoningTexts() {
      return calls.filter((call) => call.text.startsWith("Reasoning:\n")).map((call) => call.text);
    },
    finalAssistantText() {
      const texts = nonReasoningTexts();
      return texts.at(-1) ?? "";
    },
    hadIncrementalAssistantOutput() {
      const texts = nonReasoningTexts();
      if (texts.length < 2) return false;
      const finalText = texts.at(-1) ?? "";
      return texts.slice(0, -1).some((text) => text.trim() && text.trim() !== finalText.trim());
    },
    methods() {
      return calls.map((call) => call.method);
    },
  };
}
