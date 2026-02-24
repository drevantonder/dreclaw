import { describe, expect, it } from "vitest";
import { formatTelegramHtml, parseUpdate } from "../../src/telegram";

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

  it("styles known labels", () => {
    const formatted = formatTelegramHtml("Tool start: bash");
    expect(formatted).toBe("<b>Tool start:</b> <code>bash</code>");
  });
});
