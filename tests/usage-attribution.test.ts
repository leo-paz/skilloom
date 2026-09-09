import { describe, expect, it } from "vitest";
import { queryInventory } from "../src/core/query.js";
import { buildLibrary, filterLibrary, usageLabel } from "../src/tui/catalog.js";
import { inventoryFixture } from "./tui-fixture.js";

const filters = { query: "", machine: "all", scope: "all", ownership: "all" };
describe("published usage attribution and fleet coverage", () => {
  it("keeps installation and machine identities separate, including name-only invocations", () => {
    const inventory = inventoryFixture();
    const skill = inventory.globalSkills[0]!;
    inventory.projects[0]!.checkouts = [
      {
        path: "/first",
        skills: [
          {
            ...skill,
            scope: "project",
            source: "first/source",
            usagePathIds: ["b".repeat(64)],
          },
        ],
      },
      {
        path: "/second",
        skills: [
          {
            ...skill,
            scope: "project",
            source: "second/source",
            usagePathIds: ["c".repeat(64)],
          },
        ],
      },
    ];
    inventory.skillUsage!.usage.push({
      name: skill.name,
      harness: "claude",
      evidence: "invoke",
      count: 1,
      lastUsedAt: inventory.observedAt,
    });
    const remote = inventory.remoteObservations![0]!;
    remote.globalSkills = [{ ...skill }];
    remote.skillUsage = {
      ...structuredClone(inventory.skillUsage!),
      usage: [{ ...inventory.skillUsage!.usage[0]!, harness: "pi", count: 3 }],
      history: [{ ...inventory.skillUsage!.history![0]!, harness: "pi" }],
    };
    const records = queryInventory(inventory, { query: "code-review" });
    expect(
      records
        .find((r) => r.machine.id === "local" && r.scope === "global")
        ?.usedBy?.map((x) => x.harness),
    ).toEqual(["codex"]);
    expect(
      records
        .filter((r) => r.checkoutPath)
        .every((r) => r.usedBy?.length === 0),
    ).toBe(true);
    expect(
      records
        .find((r) => r.machine.id === "remote")
        ?.usedBy?.map((x) => x.harness),
    ).toEqual(["pi"]);
    expect(
      records.find((r) => r.checkoutPath === "/first")?.nameEvidence?.[0]
        ?.evidence,
    ).toBe("invoke");
    expect(
      records.find((r) => r.checkoutPath === "/first")?.usageHistory,
    ).toEqual([]);
    expect(
      records.find((r) => r.machine.id === "remote")?.usageHistory?.[0]
        ?.harness,
    ).toBe("pi");
    expect(
      records.find((r) => r.machine.id === "local" && r.scope === "global")
        ?.usageHistory?.[0]?.harness,
    ).toBe("codex");
    expect(
      queryInventory(inventory, { source: "second/source" })[0]?.usedBy,
    ).toEqual([]);
    expect(
      filterLibrary(buildLibrary(inventory), {
        ...filters,
        query: "second/source",
      })[0]?.usedBy,
    ).toEqual([]);
  });
  it("counts uncollected registered machines even when they publish no installations", () => {
    const inventory = inventoryFixture();
    inventory.skillUsage!.coverage.status = "complete";
    inventory.skillUsage!.coverage.limitsHit = [];
    inventory.skillUsage!.usage = [];
    inventory.machines.push({
      id: "missing",
      name: "Missing",
      profile: "personal",
    });
    const library = buildLibrary(inventory);
    expect(library[0]?.usageMachines).toHaveLength(3);
    expect(usageLabel(library[0]!)).toBe("Partial");
    expect(
      usageLabel(filterLibrary(library, { ...filters, machine: "local" })[0]!),
    ).toBe("No match");
    expect(
      usageLabel(filterLibrary(library, { ...filters, machine: "remote" })[0]!),
    ).toBe("Unscanned");
  });
  it("does not reuse legacy name-only read summaries as verified evidence", () => {
    const inventory = inventoryFixture();
    Object.assign(inventory.skillUsage!, { version: 1 });
    expect(queryInventory(inventory)[0]?.usedBy).toBeUndefined();
    expect(usageLabel(buildLibrary(inventory)[0]!)).toBe("Unscanned");
  });
});
