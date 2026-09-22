import { expect, it } from "vitest";
import {
  buildLibrary,
  filterLibrary,
  groupLibraryBySource,
} from "../src/tui/catalog.js";
import { inventoryFixture } from "./tui-fixture.js";

it("splits same-name installations by recorded origin without inventing project provenance", () => {
  const inventory = inventoryFixture();
  inventory.globalSkills.push({
    ...inventory.globalSkills[0]!,
    source: "other/review",
  });
  const groups = groupLibraryBySource(buildLibrary(inventory));
  const first = groups.find((g) => g.label === "acme / review")!;
  const second = groups.find((g) => g.label === "other / review")!;
  expect(first.entries.map((e) => e.name)).toContain("code-review");
  expect(second.entries.map((e) => e.name)).toContain("code-review");
  expect(
    first.entries
      .flatMap((e) => e.occurrences)
      .every((o) => o.source === "acme/review"),
  ).toBe(true);
  expect(
    second.entries
      .flatMap((e) => e.occurrences)
      .every((o) => o.source === "other/review"),
  ).toBe(true);
  expect(groups.at(-1)?.label).toBe("Source unknown");
  expect(groups.at(-1)?.entries.map((e) => e.name)).toContain("design-system");
  expect(groups.some((g) => g.label.includes("catalog"))).toBe(false);
});
it("groups only filtered occurrences and keeps source identities distinct", () => {
  const inventory = inventoryFixture();
  inventory.globalSkills.push({
    ...inventory.globalSkills[0]!,
    source: "https://gitlab.com/acme/review",
  });
  const rows = filterLibrary(buildLibrary(inventory), {
    query: "code-review",
    machine: "local",
    scope: "global",
    ownership: "all",
  });
  const groups = groupLibraryBySource(rows);
  expect(groups).toHaveLength(2);
  expect(new Set(groups.map((g) => g.key)).size).toBe(2);
  expect(
    groups
      .flatMap((g) => g.entries)
      .every((e) =>
        e.occurrences.every(
          (o) => o.machine.id === "local" && o.scope === "global",
        ),
      ),
  ).toBe(true);
});

it("combines equivalent GitHub origins but preserves different repositories", () => {
  const inventory = inventoryFixture();
  inventory.projects = [];
  inventory.remoteObservations = [];
  inventory.globalSkills.push({
    ...inventory.globalSkills[0]!,
    source: "https://github.com/acme/review.git",
  });
  inventory.globalSkills.push({
    ...inventory.globalSkills[0]!,
    source: "git@github.com:acme/review.git",
  });
  inventory.globalSkills.push({
    ...inventory.globalSkills[0]!,
    source: "acme/another",
  });
  const groups = groupLibraryBySource(buildLibrary(inventory));
  expect(groups).toHaveLength(2);
  expect(
    groups.find((g) => g.label === "acme / review")?.entries[0]?.occurrences,
  ).toHaveLength(3);
});
