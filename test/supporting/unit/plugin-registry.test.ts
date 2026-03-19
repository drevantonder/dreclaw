import { describe, expect, it } from "vite-plus/test";
import { createPluginRegistry } from "../../../src/core/plugins/registry";

describe("plugin registry", () => {
  it("rejects duplicate owned tables", () => {
    expect(() =>
      createPluginRegistry([
        { name: "one", ownedTables: ["dup_table"] },
        { name: "two", ownedTables: ["dup_table"] },
      ]),
    ).toThrow(/Duplicate plugin-owned table/);
  });

  it("rejects duplicate plugin names", () => {
    expect(() => createPluginRegistry([{ name: "dup" }, { name: "dup" }])).toThrow(
      /Duplicate plugin name/,
    );
  });
});
