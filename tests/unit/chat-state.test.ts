import { describe, expect, it } from "vite-plus/test";
import { createD1StateAdapter } from "../../src/chat-state";
import { FakeD1 } from "../helpers/fakes";

describe("chat state adapter", () => {
  it("stores subscriptions, kv values, and locks", async () => {
    const db = new FakeD1();
    const state = createD1StateAdapter(db as unknown as D1Database);

    await state.subscribe("telegram:777");
    expect(await state.isSubscribed("telegram:777")).toBe(true);

    await state.set("thread:state", { ok: true }, 60_000);
    expect(await state.get<{ ok: boolean }>("thread:state")).toEqual({ ok: true });
    expect(await state.setIfNotExists("thread:state", { ok: false }, 60_000)).toBe(false);

    const lock = await state.acquireLock("telegram:777", 60_000);
    expect(lock).not.toBeNull();
    expect(await state.acquireLock("telegram:777", 60_000)).toBeNull();
    expect(await state.extendLock(lock!, 60_000)).toBe(true);
    await state.releaseLock(lock!);
    expect(await state.acquireLock("telegram:777", 60_000)).not.toBeNull();
  });
});
