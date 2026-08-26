import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { GitAdapter } from "../adapters/git.js";
import { SkillsAdapter } from "../adapters/skills.js";
import {
  findProjectRoot,
  loadLocalMachine,
  loadMachineId,
  loadManagedState,
  loadUserConfig,
  resolveConfigPaths,
} from "../core/config.js";
import { buildInventory } from "../core/inventory.js";
import type {
  LocalMachine,
  MachineInventory,
  UserConfig,
} from "../core/types.js";
import type { CliRuntime } from "./runtime.js";

async function pullManaged(
  config: UserConfig,
  configPath: string,
): Promise<UserConfig> {
  if (config.storage.mode !== "managed") return config;
  await new GitAdapter().pull(dirname(configPath));
  return loadUserConfig(configPath);
}

async function localMachine(
  runtime: CliRuntime,
  machinePath: string,
  machineIdPath: string,
  config: UserConfig,
): Promise<LocalMachine> {
  try {
    return await loadLocalMachine(machinePath);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !error.message.includes("run skilloom setup")
    ) {
      throw error;
    }
    const id = await loadMachineId(machineIdPath);
    const root = findProjectRoot(runtime.cwd);
    return {
      id,
      name: config.machines[id]?.name ?? id,
      workspaces: root ? [{ path: root, depth: 1 }] : [],
    };
  }
}

export async function loadCurrentInventory(
  runtime: CliRuntime,
  explicitConfigPath?: string,
): Promise<MachineInventory> {
  const paths = resolveConfigPaths(runtime.env, explicitConfigPath);
  const config = await pullManaged(
    await loadUserConfig(paths.configPath),
    paths.configPath,
  );
  const machine = await localMachine(
    runtime,
    paths.machinePath,
    paths.machineIdPath,
    config,
  );
  const managed = await loadManagedState(paths.statePath);
  const skills = new SkillsAdapter(runtime.run);
  const inventory = await buildInventory(
    { machine, config, managed, cwd: runtime.cwd, env: runtime.env },
    {
      listSkills: (scope, cwd, env) => skills.list(scope, cwd, env),
      projectRemote: async (cwd) => {
        const result = await runtime.run(
          "git",
          ["config", "--get", "remote.origin.url"],
          { cwd, env: runtime.env },
        );
        return result.code === 0 && result.stdout.trim()
          ? result.stdout.trim()
          : null;
      },
    },
  );
  try {
    const observationDir = join(dirname(paths.configPath), "observations");
    const files = (await readdir(observationDir)).filter((file) =>
      file.endsWith(".json"),
    );
    for (const file of files) {
      try {
        const observed = JSON.parse(
          await readFile(join(observationDir, file), "utf8"),
        ) as {
          observedAt?: unknown;
          machine?: { id?: unknown };
          discovery?: { projectsFound?: unknown };
          globalSkills?: unknown;
          operations?: unknown;
        };
        if (
          typeof observed.observedAt !== "string" ||
          typeof observed.machine?.id !== "string"
        ) {
          continue;
        }
        const machine = inventory.machines.find(
          (candidate) => candidate.id === observed.machine?.id,
        );
        if (!machine || machine.local) continue;
        machine.observedAt = observed.observedAt;
        if (typeof observed.discovery?.projectsFound === "number") {
          machine.projects = observed.discovery.projectsFound;
        }
        if (Array.isArray(observed.globalSkills)) {
          machine.globalSkills = observed.globalSkills.filter(
            (skill) =>
              skill &&
              typeof skill === "object" &&
              (skill as { installed?: unknown }).installed === true,
          ).length;
        }
        if (Array.isArray(observed.operations)) {
          machine.changes = observed.operations.length;
        }
      } catch {
        // A stale or partial remote observation must not hide local state.
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return inventory;
}

export async function showInventory(
  runtime: CliRuntime,
  json: boolean,
  explicitConfigPath?: string,
): Promise<number> {
  const inventory = await loadCurrentInventory(runtime, explicitConfigPath);
  const installed =
    inventory.globalSkills.filter((skill) => skill.installed).length +
    inventory.projects.reduce(
      (total, project) =>
        total + project.skills.filter((skill) => skill.installed).length,
      0,
    );
  runtime.stdout(
    json
      ? JSON.stringify({ ok: true, command: "inventory", ...inventory })
      : [
          `${inventory.machine.name} · ${inventory.machine.profile}`,
          `${inventory.discovery.projectsFound} project(s) · ${installed} installed skill(s) · ${inventory.operations.length} change(s)`,
        ].join("\n"),
  );
  return 0;
}
