import { describe, expect, it } from "vite-plus/test";
import { handleHealthRequest } from "../../src/http/controllers/health";

describe("handleHealthRequest", () => {
  it("returns the service health payload", async () => {
    const response = handleHealthRequest();
    const body = (await response.json()) as { ok: boolean; service: string; ts: number };

    expect(response.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.service).toBe("dreclaw");
    expect(typeof body.ts).toBe("number");
  });
});
