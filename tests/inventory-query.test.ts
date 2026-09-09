import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadCurrentInventory } from "../src/cli/inventory.js";
import {
  resolveConfigPaths,
  saveInventorySnapshot,
} from "../src/core/config.js";
import { queryInventory } from "../src/core/query.js";
import type { InventorySkill, MachineInventory } from "../src/core/types.js";

const skill: InventorySkill = {
  name: "review",
  source: null,
  scope: "project",
  agents: ["codex"],
  installed: true,
  desired: false,
  managed: false,
  ownership: "repository",
  reasons: [],
};
function fixture(): MachineInventory {
  return {
    version: 1,
    observedAt: "2026-09-01T00:00:00Z",
    machine: { id: "a", name: "Local", profile: "default" },
    discovery: {
      status: "found",
      roots: [],
      projectsFound: 1,
      checkoutsFound: 2,
    },
    profiles: ["default"],
    machines: [],
    globalSkills: [
      {
        ...skill,
        scope: "global",
        ownership: "personal",
        source: "test/skills",
      },
    ],
    projects: [
      {
        id: "test/repo",
        name: "repo",
        remote: null,
        skills: [skill],
        operations: [],
        checkouts: [
          { path: "/temporary/clone-a", skills: [skill] },
          {
            path: "/temporary/clone-b",
            skills: [
              { ...skill, ownership: "personal", source: "other/skills" },
            ],
          },
        ],
      },
    ],
    operations: [],
    remoteObservations: [
      {
        machine: { id: "b", name: "Remote" },
        observedAt: "2026-08-01T00:00:00Z",
        globalSkills: [{ ...skill, scope: "global", ownership: "personal" }],
        projects: [{ id: "test/repo", name: "repo", skills: [skill] }],
      },
    ],
  };
}

describe("inventory queries", () => {
  it("keeps checkout facts distinct and labels remote global and project snapshots", () => {
    const records = queryInventory(fixture());
    expect(records).toHaveLength(5);
    expect(records.filter((record) => record.machine.id === "b")).toEqual([
      expect.objectContaining({
        scope: "global",
        stale: true,
        observedAt: "2026-08-01T00:00:00Z",
      }),
      expect.objectContaining({ scope: "project", stale: true }),
    ]);
    expect(
      records
        .filter((record) => record.machine.id === "b")
        .every((record) => record.checkoutPath === undefined),
    ).toBe(true);
    expect(
      queryInventory(fixture(), {
        machine: "a",
        ownership: "personal",
        scope: "project",
        source: "other/skills",
        query: "clone-b",
      }),
    ).toHaveLength(1);
    expect(queryInventory(fixture(), { source: "unknown" })).toHaveLength(3);
  });

  it("does not invent remote global state absent from older snapshots", () => {
    const inventory = fixture();
    delete inventory.remoteObservations![0]!.globalSkills;
    expect(
      queryInventory(inventory, { machine: "b", scope: "global" }),
    ).toEqual([]);
    expect(inventory.remoteObservations![0]!.globalSkills).toBeUndefined();
  });

  it("loads cached inventory without config, subprocesses or rescanning", async () => {
    const root = await mkdtemp(join(tmpdir(), "skilloom-cached-"));
    const env = { HOME: root, XDG_CONFIG_HOME: join(root, ".config") };
    await saveInventorySnapshot(
      resolveConfigPaths(env).inventoryPath,
      fixture(),
    );
    const inventory = await loadCurrentInventory(
      {
        cwd: root,
        env,
        isTTY: false,
        stdout: () => {},
        stderr: () => {},
        confirm: async () => false,
        run: async () => {
          throw new Error("must not spawn");
        },
      },
      undefined,
      { cached: true },
    );
    expect(inventory.cached).toBe(true);
    expect(queryInventory(inventory).every((record) => record.stale)).toBe(
      true,
    );
    expect(inventory.observedAt).toBe("2026-09-01T00:00:00Z");
  });
});

it("preserves independent remote checkout sources and ownership through publication and reload", async () => {
  const { execFileSync } = await import("node:child_process");
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { vi } = await import("vitest");
  const { GitAdapter } = await import("../src/adapters/git.js");
  const { buildInventory } = await import("../src/core/inventory.js");
  const { loadUserConfig, saveUserConfig } = await import(
    "../src/core/config.js"
  );
  const { runCli } = await import("../src/cli/app.js");
  const { observeMachine } = await import("../src/cli/observe.js");
  const root = await mkdtemp(join(tmpdir(), "skilloom-remote-clones-"));
  const workspaces = join(root, "workspaces");
  const first = join(workspaces, "a");
  const second = join(workspaces, "b");
  await mkdir(join(first, ".claude/skills/review"), { recursive: true });
  await writeFile(join(first, ".claude/skills/review/SKILL.md"), "review");
  execFileSync("git", ["init", "-q", first]);
  execFileSync("git", ["-C", first, "add", ".claude"]);
  execFileSync("git", [
    "-C",
    first,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.com",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-qm",
    "fixture",
  ]);
  execFileSync("git", ["clone", "-q", first, second]);
  execFileSync("git", ["-C", second, "rm", "-qr", "--cached", ".claude"]);
  const env = { HOME: root, XDG_CONFIG_HOME: join(root, ".config") };
  const runtime = {
    cwd: root,
    env,
    isTTY: false,
    stdout: () => {},
    stderr: () => {},
    confirm: async () => true,
    run: async () => ({ code: 0, stdout: "[]", stderr: "" }),
  };
  await runCli(["init", "--yes"], runtime);
  const paths = resolveConfigPaths(env);
  const config = await loadUserConfig(paths.configPath);
  config.machines.remote = { profile: "default", name: "Remote" };
  const observed = await buildInventory(
    {
      machine: {
        id: "remote",
        name: "Remote",
        workspaces: [{ path: workspaces, depth: 1 }],
      },
      config,
      managed: new Set(),
      cwd: root,
      env,
    },
    {
      projectRemote: async () => "https://github.com/test/repo.git",
      listSkills: async (scope, cwd) =>
        scope === "global"
          ? []
          : [
              {
                name: "review",
                scope,
                agents: ["claude-code"],
                source: cwd.endsWith("/a") ? "acme/first" : "acme/second",
                path: join(cwd, ".claude/skills/review"),
              },
            ],
    },
  );
  const { prepareUsagePaths } = await import("../src/core/usage-paths.js");
  await prepareUsagePaths(observed, env);
  const firstPathId = observed.projects[0]!.checkouts.find(
    (checkout) => checkout.skills?.[0]?.source === "acme/first",
  )!.skills![0]!.usagePathIds![0]!;
  observed.skillUsage = {
    version: 2,
    usage: [
      {
        name: "review",
        pathId: firstPathId,
        harness: "codex",
        evidence: "read",
        count: 1,
        lastUsedAt: observed.observedAt,
      },
    ],
    coverage: {
      status: "complete",
      filesDiscovered: 1,
      filesScanned: 1,
      bytesRead: 100,
      limitsHit: [],
      observedAt: observed.observedAt,
    },
  };
  config.storage = {
    mode: "managed",
    repository: "https://github.com/test/config.git",
  };
  await saveUserConfig(paths.configPath, config);
  const push = vi
    .spyOn(GitAdapter.prototype, "commitObservationAndPush")
    .mockResolvedValue(undefined);
  try {
    await observeMachine(["--publish"], runtime, true, observed);
  } finally {
    push.mockRestore();
  }
  config.storage = { mode: "local" };
  await saveUserConfig(paths.configPath, config);
  const reloaded = await loadCurrentInventory(runtime);
  const records = queryInventory(reloaded, {
    machine: "remote",
    scope: "project",
  });
  expect(records).toHaveLength(2);
  expect(records).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        source: "acme/first",
        ownership: "repository",
        checkoutId: expect.any(String),
        stale: true,
      }),
      expect.objectContaining({
        source: "acme/second",
        ownership: "personal",
        checkoutId: expect.any(String),
        stale: true,
      }),
    ]),
  );
  expect(new Set(records.map((record) => record.checkoutId)).size).toBe(2);
  expect(records.every((record) => record.checkoutPath === undefined)).toBe(
    true,
  );
  const publication = await (await import("node:fs/promises")).readFile(
    join(root, ".config/skilloom/observations/remote.json"),
    "utf8",
  );
  expect(publication).not.toContain(workspaces);
  expect(publication).toContain(firstPathId);
  expect(
    records.find((record) => record.source === "acme/first")?.usedBy,
  ).toEqual(observed.skillUsage.usage);
  expect(
    records.find((record) => record.source === "acme/second")?.usedBy,
  ).toEqual([]);
});
