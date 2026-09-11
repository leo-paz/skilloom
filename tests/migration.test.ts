import { describe, expect, it } from "vitest";
import { buildMigrationPreview } from "../src/core/migration.js";
import { managedStateKey } from "../src/core/plan.js";
import type {
  InventorySkill,
  MachineInventory,
  UserConfig,
} from "../src/core/types.js";

const requirement = {
  name: "review",
  source: "acme/skills",
  agents: ["codex"],
};
const skill: InventorySkill = {
  ...requirement,
  scope: "project",
  installed: true,
  desired: true,
  managed: true,
  ownership: "repository",
  reasons: [],
};
function fixture() {
  const config: UserConfig = {
    version: 1,
    storage: { mode: "local" },
    profiles: { default: { skills: [] } },
    machines: { m: { profile: "default", name: "Machine" } },
    projects: { repo: { skills: [requirement] } },
    projectProfiles: {},
  };
  const inventory = {
    discovery: { status: "found" },
    projects: [
      {
        id: "repo",
        checkouts: [
          { path: "/fixture/a", skills: [skill] },
          { path: "/fixture/b", skills: [skill] },
        ],
      },
    ],
  } as MachineInventory;
  const managed = new Set([
    managedStateKey(skill, "/fixture/a"),
    managedStateKey(skill, "/fixture/b"),
    "global:unrelated",
  ]);
  return { config, inventory, managed };
}
describe("legacy migration preview", () => {
  it("removes duplicate repository policy and only matching obsolete ownership", () => {
    const f = fixture();
    const p = buildMigrationPreview(f.config, f.managed, f.inventory);
    expect(p.requirements).toHaveLength(1);
    expect(p.requirements[0]?.reason).toBe("repository-owned");
    expect(p.stateKeys).toHaveLength(2);
    expect(f.config.projects.repo?.skills).toHaveLength(1);
    expect(f.managed.size).toBe(3);
  });
  it("preserves policy whose source differs from installed repository content", () => {
    const f = fixture();
    f.config.projects.repo!.skills = [
      { ...requirement, source: "other/source" },
    ];
    expect(
      buildMigrationPreview(f.config, f.managed, f.inventory).requirements,
    ).toEqual([]);
  });
  it("identifies divergent personal clones only with matching legacy ownership", () => {
    const f = fixture();
    f.inventory.projects[0]!.checkouts[0]!.skills = [
      { ...skill, ownership: "personal" },
    ];
    f.inventory.projects[0]!.checkouts[1]!.skills = [];
    expect(
      buildMigrationPreview(f.config, f.managed, f.inventory).requirements[0]
        ?.reason,
    ).toBe("divergent-checkouts");
    f.managed.clear();
    expect(
      buildMigrationPreview(f.config, f.managed, f.inventory).requirements,
    ).toEqual([]);
  });
  it("releases every obsolete source claim for divergent installed clones", () => {
    const f = fixture();
    f.inventory.projects[0]!.checkouts[0]!.skills = [
      { ...skill, ownership: "personal" },
    ];
    const other = {
      ...skill,
      source: "other/source",
      ownership: "personal" as const,
    };
    f.inventory.projects[0]!.checkouts[1]!.skills = [other];
    const otherKey = managedStateKey(other, "/fixture/b");
    f.managed.add(otherKey);
    f.managed.add(managedStateKey(other, "/unobserved"));
    const result = buildMigrationPreview(f.config, f.managed, f.inventory);
    expect(result.requirements).toHaveLength(1);
    expect(result.stateKeys).toContain(otherKey);
    expect(result.stateKeys).toHaveLength(3);
  });
  it("releases stale repository ownership even when upstream lost source metadata", () => {
    const f = fixture();
    f.config.projects.repo!.skills = [];
    f.inventory.projects[0]!.checkouts[0]!.skills = [
      { ...skill, source: null },
    ];
    expect(
      buildMigrationPreview(f.config, f.managed, f.inventory).stateKeys,
    ).toHaveLength(2);
  });
  it("blocks incomplete inventory and protects unobserved projects", () => {
    const f = fixture();
    f.inventory.discovery.status = "incomplete";
    expect(
      buildMigrationPreview(f.config, f.managed, f.inventory).blockers,
    ).not.toEqual([]);
    f.inventory.projects = [];
    expect(
      buildMigrationPreview(f.config, f.managed, f.inventory).requirements,
    ).toEqual([]);
  });
});
