import { describe, expect, it } from "vite-plus/test";
import { buildRuntimeDeps } from "../../src/app/deps";
import { createLoopServices } from "../../src/core/loop/runtime";
import { createEnv } from "../helpers/fakes";

describe("loop runtime composition", () => {
  it("assembles explicit services without a runtime facade", () => {
    const { env } = createEnv();
    const services = createLoopServices(buildRuntimeDeps(env));

    expect(services.controls.help()).toContain("/status");
    expect(typeof services.conversation.runConversationInline).toBe("function");
    expect(typeof services.conversation.runConversationStep).toBe("function");
    expect(typeof services.wake.runProactiveWake).toBe("function");
  });
});
