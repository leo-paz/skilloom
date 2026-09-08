import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildInventory } from "../src/core/inventory.js";
import { managedStateKey } from "../src/core/plan.js";
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
  it("reports a tracked skill missing from upstream as protected and unresolved", async () => {
    const root = await mkdtemp(join(tmpdir(), "skilloom-tracked-missing-"));
    await mkdir(join(root, ".agents/skills/review"), { recursive: true });
    await writeFile(join(root, ".agents/skills/review/SKILL.md"), "review");
    await mkdir(join(root, "src/skills"), { recursive: true });
    await mkdir(join(root, "skills/source-only"), { recursive: true });
    await writeFile(join(root, "src/skills/parser.ts"), "export {};");
    await writeFile(join(root, "skills/README.md"), "sources");
    await writeFile(join(root, "skills/source-only/SKILL.md"), "source only");
    execFileSync("git", ["init", root]);
    execFileSync("git", ["-C", root, "add", "."]);
    const config = emptyConfig("a");
    config.projects["github.com/test/repo"] = {
      skills: [{ name: "review", source: "test/skills", agents: ["codex"] }],
    };
    const inventory = await buildInventory(
      {
        machine: {
          id: "a",
          name: "Test",
          workspaces: [{ path: root, depth: 1 }],
        },
        config,
        managed: new Set(),
        cwd: root,
        env: {},
      },
      {
        listSkills: async () => [],
        projectRemote: async () => "https://github.com/test/repo.git",
      },
    );
    expect(inventory.operations).toEqual([]);
    expect(inventory.projects[0]?.checkouts[0]?.skills).toEqual([
      expect.objectContaining({
        name: "review",
        installed: false,
        ownership: "repository",
        conflict: expect.any(String),
      }),
    ]);
    const present = await buildInventory(
      {
        machine: {
          id: "a",
          name: "Test",
          workspaces: [{ path: root, depth: 1 }],
        },
        config,
        managed: new Set(),
        cwd: root,
        env: {},
      },
      {
        listSkills: async (scope) =>
          scope === "global"
            ? []
            : [{ name: "review", source: null, agents: ["codex"], scope }],
        projectRemote: async () => "https://github.com/test/repo.git",
      },
    );
    expect(
      present.projects[0]?.checkouts[0]?.skills?.[0]?.conflict,
    ).toBeUndefined();
    expect(present.projects[0]?.checkouts[0]?.skills?.[0]?.installed).toBe(
      true,
    );
    config.profiles.default!.skills = [
      { name: "personal", source: "test/skills", agents: ["codex"] },
    ];
    const unknown = await buildInventory(
      {
        machine: { id: "a", name: "Test", workspaces: [] },
        config,
        managed: new Set(),
        cwd: root,
        env: {},
      },
      {
        listSkills: async (scope) => [
          { name: "personal", source: null, agents: [], scope },
        ],
        projectRemote: async () => null,
      },
    );
    expect(unknown.globalSkills[0]).toMatchObject({
      name: "personal",
      installed: true,
      conflict: expect.stringContaining("unknown source or agent coverage"),
    });
  });
  it("excludes linked worktrees and protects tracked skills despite stale management", async () => {
    const root = await mkdtemp(join(tmpdir(), "skilloom-git-inventory-"));
    const repo = join(root, "repo");
    const worktree = join(root, "review");
    await mkdir(join(repo, ".agents/skills/review"), { recursive: true });
    await writeFile(join(repo, ".agents/skills/review/SKILL.md"), "review");
    const external = join(root, "external-skill");
    await mkdir(external);
    await writeFile(join(external, "SKILL.md"), "external");
    await symlink(external, join(repo, ".agents/skills/linked"));
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", repo, ...args]);
    git("init");
    git("add", ".");
    git(
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      "initial",
    );
    git("worktree", "add", "-b", "review", worktree);
    const duplicate = join(root, "duplicate");
    execFileSync("git", ["clone", repo, duplicate]);
    const config = emptyConfig("a");
    config.projects["github.com/test/repo"] = {
      skills: [{ name: "review", source: "other/source", agents: ["codex"] }],
    };
    const inventory = await buildInventory(
      {
        machine: {
          id: "a",
          name: "Test",
          workspaces: [{ path: root, depth: 2 }],
        },
        config,
        managed: new Set([
          managedStateKey(
            { scope: "project", name: "linked", source: "original/source" },
            await realpath(repo),
          ),
          managedStateKey(
            { scope: "project", name: "review", source: "original/source" },
            await realpath(repo),
          ),
        ]),
        cwd: root,
        env: {},
      },
      {
        listSkills: async (scope) =>
          scope === "global"
            ? []
            : [
                {
                  name: "review",
                  source: "original/source",
                  agents: ["codex"],
                  scope,
                },
                {
                  name: "linked",
                  source: "original/source",
                  agents: ["codex"],
                  scope,
                  path: external,
                },
              ],
        projectRemote: async () => "https://github.com/test/repo.git",
      },
    );
    expect(inventory.discovery.checkoutsFound).toBe(2);
    expect(inventory.operations).toEqual([]);
    expect(inventory.projects[0]?.checkouts[0]?.skills).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ownership: "repository",
          managed: false,
          source: "original/source",
          desiredSource: "other/source",
          conflict: expect.any(String),
        }),
        expect.objectContaining({
          name: "linked",
          ownership: "repository",
          managed: false,
        }),
      ]),
    );
  });
  it("discovers nested Git projects and groups checkouts by canonical remote", async () => {
    const root = await mkdtemp(join(tmpdir(), "skilloom-inventory-"));
    const first = join(root, "personal", "skilloom");
    const second = join(root, "worktrees", "skilloom-review");
    const ignored = join(root, "node_modules", "ignored");
    await mkdir(first, { recursive: true });
    execFileSync("git", ["init", first]);
    await mkdir(second, { recursive: true });
    execFileSync("git", [
      "init",
      "--separate-git-dir",
      join(root, "separate-git"),
      second,
    ]);
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
      checkouts: [
        { path: await realpath(first) },
        { path: await realpath(second) },
      ],
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
