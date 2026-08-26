import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildInventory } from "../src/core/inventory.js";
import type { InstalledSkill, UserConfig } from "../src/core/types.js";

const emptyConfig = (machineId: string): UserConfig => ({
  version: 1,
  storage: { mode: "local" },
  profiles: { default: { skills: [] } },
  machines: { [machineId]: { profile: "default", name: "Test Mac" } },
  projectProfiles: {},
  projects: {},
});

describe("machine inventory", () => {
  it("discovers nested Git projects and groups checkouts by canonical remote", async () => {
    const root = await mkdtemp(join(tmpdir(), "skilloom-inventory-"));
    const first = join(root, "personal", "skilloom");
    const second = join(root, "worktrees", "skilloom-review");
    const ignored = join(root, "node_modules", "ignored");
    await mkdir(join(first, ".git"), { recursive: true });
    await mkdir(second, { recursive: true });
    await writeFile(join(second, ".git"), "gitdir: /tmp/common\n");
    await mkdir(join(ignored, ".git"), { recursive: true });

    const projectSkills: InstalledSkill[] = [
      {
        name: "tdd",
        source: "mattpocock/skills",
        agents: ["codex"],
        scope: "project",
      },
    ];
    const inventory = await buildInventory(
      {
        machine: {
          id: "machine-a",
          name: "Test Mac",
          workspaces: [{ path: root, depth: 3 }],
        },
        config: emptyConfig("machine-a"),
        managed: new Set(),
        cwd: root,
        env: { HOME: root },
      },
      {
        listSkills: async (scope) => (scope === "global" ? [] : projectSkills),
        projectRemote: async () => "git@github.com:leo-paz/skilloom.git",
        now: () => new Date("2026-08-26T12:00:00.000Z"),
      },
    );

    expect(inventory.discovery).toMatchObject({
      status: "found",
      projectsFound: 1,
      checkoutsFound: 2,
    });
    expect(inventory.projects).toHaveLength(1);
    expect(inventory.projects[0]).toMatchObject({
      id: "github.com/leo-paz/skilloom",
      name: "skilloom",
      checkouts: [{ path: first }, { path: second }],
    });
    expect(inventory.projects[0]?.skills).toEqual([
      expect.objectContaining({
        name: "tdd",
        installed: true,
        managed: false,
      }),
    ]);
  });

  it("treats a successful scan with no repositories as an empty inventory", async () => {
    const root = await mkdtemp(join(tmpdir(), "skilloom-empty-"));
    const inventory = await buildInventory(
      {
        machine: {
          id: "machine-a",
          name: "Test Mac",
          workspaces: [{ path: root, depth: 3 }],
        },
        config: emptyConfig("machine-a"),
        managed: new Set(),
        cwd: root,
        env: { HOME: root },
      },
      {
        listSkills: async () => [],
        projectRemote: async () => null,
        now: () => new Date("2026-08-26T12:00:00.000Z"),
      },
    );

    expect(inventory.discovery).toEqual({
      status: "empty",
      roots: [{ path: root, depth: 3, status: "scanned" }],
      projectsFound: 0,
      checkoutsFound: 0,
    });
    expect(inventory.projects).toEqual([]);
    expect(inventory.globalSkills).toEqual([]);
  });
});
