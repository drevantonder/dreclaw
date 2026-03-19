import { describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  fetchTelegramImageAsDataUrl: vi.fn(),
}));

vi.mock("../../../src/chat-adapters/telegram/api", () => ({
  fetchTelegramImageAsDataUrl: mocks.fetchTelegramImageAsDataUrl,
}));

import {
  getTelegramUserChatId,
  isPrivateTelegramUpdate,
  isTelegramPrivateMessage,
  loadTelegramImageBlocks,
} from "../../../src/chat-adapters/telegram/message";

describe("telegram message helpers", () => {
  it("detects private Telegram messages and updates", () => {
    expect(isTelegramPrivateMessage({ chat: { type: "private" } })).toBe(true);
    expect(isTelegramPrivateMessage({ chat: { type: "group" } })).toBe(false);
    expect(
      isPrivateTelegramUpdate({
        update_id: 1,
        message: { message_id: 1, date: 1, chat: { id: 7, type: "private" } },
      }),
    ).toBe(true);
    expect(
      isPrivateTelegramUpdate({
        update_id: 1,
        message: { message_id: 1, date: 1, chat: { id: 7, type: "group" } },
      }),
    ).toBe(false);
  });

  it("resolves Telegram chat id from message or thread id", () => {
    expect(getTelegramUserChatId({ chat: { id: 777 } }, "telegram:1")).toBe(777);
    expect(getTelegramUserChatId({}, "telegram:888")).toBe(888);
    expect(() => getTelegramUserChatId({}, "thread-without-id")).toThrow(
      "Missing Telegram chat id",
    );
  });

  it("loads the largest Telegram photo as an image block", async () => {
    mocks.fetchTelegramImageAsDataUrl.mockResolvedValue("data:image/png;base64,abc");

    const blocks = await loadTelegramImageBlocks("token", {
      photo: [
        { file_id: "small", file_size: 10 },
        { file_id: "large", file_size: 20 },
      ],
    });

    expect(mocks.fetchTelegramImageAsDataUrl).toHaveBeenCalledWith("token", "large");
    expect(blocks).toEqual(["data:image/png;base64,abc"]);
  });

  it("returns no image blocks when there is no usable image", async () => {
    mocks.fetchTelegramImageAsDataUrl.mockResolvedValue(null);

    await expect(loadTelegramImageBlocks("token", {})).resolves.toEqual([]);
    await expect(loadTelegramImageBlocks("token", { photo: [{ file_size: 20 }] })).resolves.toEqual(
      [],
    );
  });
});
