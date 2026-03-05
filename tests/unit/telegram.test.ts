import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatTelegramHtml, parseUpdate, sendTelegramMessageDraft } from "../../src/telegram";

describe("parseUpdate", () => {
  it("parses valid telegram update", () => {
    const update = parseUpdate({
      update_id: 123,
      message: {
        message_id: 1,
        date: 170000,
        chat: { id: 9, type: "private" },
        from: { id: 42 },
        text: "hi",
      },
    });

    expect(update).not.toBeNull();
    expect(update?.update_id).toBe(123);
    expect(update?.message?.chat.type).toBe("private");
  });

  it("rejects invalid payloads", () => {
    expect(parseUpdate(null)).toBeNull();
    expect(parseUpdate({})).toBeNull();
    expect(parseUpdate({ update_id: "1" })).toBeNull();
  });
});

describe("formatTelegramHtml", () => {
  it("escapes raw html", () => {
    const formatted = formatTelegramHtml("<b>unsafe</b> & raw");
    expect(formatted).toBe("&lt;b&gt;unsafe&lt;/b&gt; &amp; raw");
  });

  it("styles label lines", () => {
    const formatted = formatTelegramHtml("Tool start: bash");
    expect(formatted).toBe("<b>Tool start:</b> bash");
  });
});

describe("sendTelegramMessageDraft", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ ok: true, result: true }), { status: 200 })),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("calls sendMessageDraft endpoint", async () => {
    await sendTelegramMessageDraft("token", 777, 4001, "Hello draft");
    const fetchMock = vi.mocked(fetch);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/sendMessageDraft");
    const body = JSON.parse(String(init?.body)) as { draft_id: number; chat_id: number; text: string; parse_mode: string };
    expect(body.chat_id).toBe(777);
    expect(body.draft_id).toBe(4001);
    expect(body.text).toBe("Hello draft");
    expect(body.parse_mode).toBe("HTML");
  });

  it("throws on telegram error response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ ok: false }), { status: 500 })),
    );
    await expect(sendTelegramMessageDraft("token", 777, 4001, "Hello draft")).rejects.toThrow(
      "Telegram draft send failed",
    );
  });
});
