import { describe, expect, it } from "vitest";
import {
  buildLibrary,
  filterLibrary,
  ownershipLabel,
} from "../src/tui/catalog.js";
import { inventoryFixture } from "./tui-fixture.js";

const filters = {
  query: "code-review",
  machine: "all",
  scope: "all",
  ownership: "all",
};
describe("library ownership summaries", () => {
  it("shows Git for a skill with repository copies and preserves every owner in the preview and filtered results", () => {
    const inventory = inventoryFixture();
    inventory.projects[0]!.checkouts[0]!.skills![0]!.name = "code-review";
    inventory.remoteObservations![0]!.globalSkills = [
      { ...inventory.globalSkills[0]!, managed: false },
    ];
    const rows = filterLibrary(buildLibrary(inventory), filters);
    expect(rows[0]?.ownership).toBe("Git");
    expect(rows[0]?.owners).toEqual(["Git", "Skilloom", "External"]);
    expect(rows[0]?.occurrences.map(ownershipLabel)).toEqual(
      expect.arrayContaining(["Git", "Skilloom", "External"]),
    );
    const remote = filterLibrary(rows, { ...filters, machine: "remote" });
    expect(remote[0]?.ownership).toBe("External");
    expect(remote[0]?.owners).toEqual(["External"]);
    const managed = filterLibrary(rows, { ...filters, ownership: "skilloom" });
    expect(managed[0]?.ownership).toBe("Skilloom");
    expect(managed[0]?.occurrences).toHaveLength(1);
  });
  it("shows Skilloom ahead of External regardless of machine order", () => {
    const inventory = inventoryFixture();
    inventory.remoteObservations![0]!.globalSkills = [
      { ...inventory.globalSkills[0]!, managed: false },
    ];
    for (let i = 0; i < 2; i++) {
      const rows = filterLibrary(buildLibrary(inventory), filters);
      expect(rows[0]?.ownership).toBe("Skilloom");
      expect(rows[0]?.owners).toEqual(["Skilloom", "External"]);
      inventory.globalSkills[0]!.managed = false;
      inventory.remoteObservations![0]!.globalSkills![0]!.managed = true;
    }
  });
});
