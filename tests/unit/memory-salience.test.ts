import { describe, expect, it } from "vitest";
import { extractFacts, scoreSalience } from "../../src/memory/salience";

describe("memory salience", () => {
  it("scores durable preference higher than chatter", () => {
    const durable = scoreSalience("Remember that I prefer short bullet points.");
    const chatter = scoreSalience("ok");

    expect(durable.score).toBeGreaterThan(chatter.score);
    expect(durable.shouldStoreEpisode).toBe(true);
  });

  it("extracts identity and preference facts", () => {
    const facts = extractFacts("My name is Dre and I prefer concise replies.");
    expect(facts.some((fact) => fact.kind === "identity")).toBe(true);
    expect(facts.some((fact) => fact.kind === "preference")).toBe(true);
  });
});
