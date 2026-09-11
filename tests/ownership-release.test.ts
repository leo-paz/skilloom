import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { initializeConfiguration } from "../src/cli/configuration.js";
import { loadCurrentInventory } from "../src/cli/inventory.js";
import { migrateConfiguration } from "../src/cli/migrate.js";
import { applyReconciliation } from "../src/cli/reconcile.js";
import type { CliRuntime } from "../src/cli/runtime.js";
import { setupMachine } from "../src/cli/setup.js";
import { syncMachine } from "../src/cli/sync.js";
import { applyWorkspacePlan } from "../src/cli/workspace-reconcile.js";
import {
  loadMachineId,
  loadManagedState,
  loadUserConfig,
  resolveConfigPaths,
  saveLocalMachine,
  saveManagedState,
  saveUserConfig,
} from "../src/core/config.js";
import { releaseOwnership } from "../src/core/ownership-release.js";
import { managedStateKey } from "../src/core/plan.js";
import { parseUserConfig } from "../src/core/schema.js";

const release = {
  id: "a".repeat(64),
  projectId: "github.com/test/repo",
  name: "review",
};
const installed = {
  name: "review",
  source: "test/skills",
  scope: "project" as const,
  agents: ["codex"],
};
describe("migration ownership releases", () => {
  it("releases each checkout once and preserves ownership acquired later", () => {
    const state = new Set([
      managedStateKey(installed, "/clone-a"),
      managedStateKey(installed, "/clone-b"),
    ]);
    const first = releaseOwnership([release], state, [
      { projectId: release.projectId, path: "/clone-a" },
    ]);
    expect(first.managed.has(managedStateKey(installed, "/clone-a"))).toBe(
      false,
    );
    expect(first.managed.has(managedStateKey(installed, "/clone-b"))).toBe(
      true,
    );
    first.managed.add(managedStateKey(installed, "/clone-a"));
    const second = releaseOwnership([release], first.managed, [
      { projectId: release.projectId, path: "/clone-a" },
      { projectId: release.projectId, path: "/clone-b" },
    ]);
    expect(second.managed.has(managedStateKey(installed, "/clone-a"))).toBe(
      true,
    );
    expect(second.managed.has(managedStateKey(installed, "/clone-b"))).toBe(
      false,
    );
  });

  it("requires config version 2 for shared release markers", () => {
    const config = {
      version: 1,
      profiles: { default: { skills: [] } },
      machines: {},
      ownershipReleases: [release],
    };
    expect(() => parseUserConfig(JSON.stringify(config))).toThrow();
    expect(
      parseUserConfig(JSON.stringify({ ...config, version: 2 }))
        .ownershipReleases,
    ).toEqual([release]);
  });

  it("protects two independent machine states during dry-run and no-op apply, then permits later deliberate removal", async () => {
    let publishedReleases = [release];
    for (const machine of ["first", "second", "legacy", "setup"]) {
      const home = await realpath(
        await mkdtemp(join(tmpdir(), `skilloom-release-${machine}-`)),
      );
      const checkout = join(home, "repo");
      await mkdir(checkout);
      execFileSync("git", ["init", "-q", checkout]);
      if (machine === "first") {
        await mkdir(join(checkout, ".claude/skills/review"), {
          recursive: true,
        });
        await writeFile(
          join(checkout, ".claude/skills/review/SKILL.md"),
          "review",
        );
        execFileSync("git", ["-C", checkout, "add", ".claude"]);
      }
      const mutations: string[][] = [];
      const runtime: CliRuntime = {
        cwd: home,
        env: { HOME: home, XDG_CONFIG_HOME: join(home, ".config") },
        isTTY: false,
        stdout: () => {},
        stderr: () => {},
        confirm: async () => true,
        run: async (executable, args) => {
          if (executable === "git")
            return {
              code: 0,
              stdout: "https://github.com/test/repo.git",
              stderr: "",
            };
          if (args.includes("list"))
            return {
              code: 0,
              stdout: JSON.stringify(
                args.includes("--global") ? [] : [installed],
              ),
              stderr: "",
            };
          mutations.push(args);
          return { code: 0, stdout: "", stderr: "" };
        },
      };
      await initializeConfiguration([], runtime, true);
      const paths = resolveConfigPaths(runtime.env);
      const id = await loadMachineId(paths.machineIdPath);
      await saveLocalMachine(paths.machinePath, {
        id,
        name: machine,
        workspaces: [{ path: checkout, depth: 1 }],
      });
      const config = await loadUserConfig(paths.configPath);
      if (machine === "first")
        config.projects[release.projectId] = {
          skills: [
            {
              name: installed.name,
              source: installed.source,
              agents: installed.agents,
            },
          ],
        };
      else {
        config.version = 2;
        config.ownershipReleases = publishedReleases;
      }
      await saveUserConfig(paths.configPath, config);
      await saveManagedState(
        paths.statePath,
        new Set([managedStateKey(installed, checkout)]),
      );
      if (machine === "first") {
        expect(await migrateConfiguration(["--yes"], runtime, true)).toBe(0);
        const migrated = await loadUserConfig(paths.configPath);
        expect(migrated.version).toBe(2);
        publishedReleases = migrated.ownershipReleases!;
        expect(publishedReleases).toEqual([
          expect.objectContaining({
            projectId: release.projectId,
            name: installed.name,
          }),
        ]);
      }
      const original = await readFile(paths.statePath, "utf8");
      expect((await loadCurrentInventory(runtime)).operations).toEqual([]);
      expect(await readFile(paths.statePath, "utf8")).toBe(original);
      if (machine === "second") {
        let output: Record<string, unknown> = {};
        const capture = {
          ...runtime,
          stdout: (line: string) => {
            output = JSON.parse(line);
          },
        };
        expect(await syncMachine(["--dry-run"], capture, true)).toBe(0);
        expect(output.ownershipRelease).toEqual(
          expect.objectContaining({
            releasedKeys: [managedStateKey(installed, checkout)],
          }),
        );
        const fingerprint = String(output.fingerprint);
        config.ownershipReleases = [
          { ...publishedReleases[0]!, id: "b".repeat(64) },
        ];
        await saveUserConfig(paths.configPath, config);
        expect(
          await syncMachine(["--yes", "--expect", fingerprint], capture, true),
        ).toBe(5);
        expect(output.error).toEqual(
          expect.objectContaining({ code: "plan_changed" }),
        );
        expect(await readFile(paths.statePath, "utf8")).toBe(original);
        config.ownershipReleases = publishedReleases;
        await saveUserConfig(paths.configPath, config);
      }
      if (machine === "setup") {
        expect(
          await setupMachine(["--machine-name", machine], runtime, true),
        ).toBe(0);
        const adopted = await loadManagedState(paths.statePath);
        expect(adopted.has(managedStateKey(installed, checkout))).toBe(true);
        const policy = await loadUserConfig(paths.configPath);
        expect(policy.projects[release.projectId]?.skills).toHaveLength(1);
        policy.projects[release.projectId]!.skills = [];
        await saveUserConfig(paths.configPath, policy);
        expect((await loadCurrentInventory(runtime)).operations).toEqual([
          expect.objectContaining({ kind: "remove" }),
        ]);
        expect(mutations).toEqual([]);
        continue;
      }
      expect(
        machine === "legacy"
          ? await applyReconciliation(
              { configPath: undefined, yes: true, json: true },
              { ...runtime, cwd: checkout },
            )
          : await applyWorkspacePlan(["--yes"], runtime, true),
      ).toBe(0);
      const acknowledged = await loadManagedState(paths.statePath);
      expect(acknowledged.has(managedStateKey(installed, checkout))).toBe(
        false,
      );
      expect(mutations).toEqual([]);
      acknowledged.add(managedStateKey(installed, checkout));
      await saveManagedState(paths.statePath, acknowledged);
      if (machine !== "first")
        expect((await loadCurrentInventory(runtime)).operations).toEqual([
          expect.objectContaining({ kind: "remove" }),
        ]);
    }
  });
});
