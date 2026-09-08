import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { GitAdapter } from "../adapters/git.js";
import { SkillsAdapter } from "../adapters/skills.js";
import {
  ensureMachineId,
  loadLocalMachine,
  loadManagedState,
  loadUserConfig,
  resolveConfigPaths,
  saveInventorySnapshot,
  saveLocalMachine,
  saveManagedState,
  saveUserConfig,
} from "../core/config.js";
import { buildInventory } from "../core/inventory.js";
import { managedStateKey } from "../core/plan.js";
import { isLocalSkillSource } from "../core/schema.js";
import type {
  InstalledSkill,
  LocalMachine,
  UserConfig,
} from "../core/types.js";
import { initializeConfiguration } from "./configuration.js";
import type { CliRuntime } from "./runtime.js";

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--"))
    throw new Error(`${name} requires a value`);
  return value;
}

function positionalWorkspace(args: string[]): string | undefined {
  const first = args[0];
  return first && !first.startsWith("--") ? first : option(args, "--workspace");
}

function workspacePath(value: string, runtime: CliRuntime): string {
  if (value === "~") {
    if (!runtime.env.HOME) throw new Error("HOME is required to expand ~");
    return runtime.env.HOME;
  }
  if (value.startsWith("~/")) {
    if (!runtime.env.HOME) throw new Error("HOME is required to expand ~");
    return resolve(runtime.env.HOME, value.slice(2));
  }
  return resolve(runtime.cwd, value);
}

function initArgs(args: string[]): string[] {
  const output: string[] = [];
  for (const name of [
    "--storage",
    "--repository",
    "--path",
    "--profile",
    "--config",
  ]) {
    const value = option(args, name);
    if (value) output.push(name, value);
  }
  if (option(args, "--repository") && !option(args, "--storage")) {
    output.push("--storage", "managed");
  }
  const syncRepository = option(args, "--sync");
  if (syncRepository) {
    if (option(args, "--storage") || option(args, "--repository")) {
      throw new Error(
        "--sync cannot be combined with --storage or --repository",
      );
    }
    output.push("--storage", "managed", "--repository", syncRepository);
  }
  return output;
}

async function machineName(
  args: string[],
  runtime: CliRuntime,
): Promise<string> {
  const explicit =
    option(args, "--machine-name") || runtime.env.SKILLOOM_MACHINE_NAME;
  if (explicit) return explicit;
  for (const [executable, commandArgs] of [
    ["scutil", ["--get", "ComputerName"]],
    ["hostname", []],
  ] as const) {
    try {
      const result = await runtime.run(executable, [...commandArgs], {
        cwd: runtime.cwd,
        env: runtime.env,
      });
      if (result.code === 0 && result.stdout.trim())
        return result.stdout.trim();
    } catch {
      // Try the portable fallback.
    }
  }
  return "This machine";
}

function defaultWorkspaces(runtime: CliRuntime): string[] {
  const home = runtime.env.HOME;
  if (!home) return [];
  return ["dev", "Developer", "projects", "code", "src"]
    .map((name) => resolve(home, name))
    .filter((path) => existsSync(path));
}

async function pullManaged(
  config: UserConfig,
  configPath: string,
): Promise<UserConfig> {
  if (config.storage.mode !== "managed") return config;
  await new GitAdapter().pull(dirname(configPath));
  return loadUserConfig(configPath);
}

export async function setupMachine(
  args: string[],
  runtime: CliRuntime,
  json: boolean,
): Promise<number> {
  let paths = resolveConfigPaths(runtime.env, option(args, "--config"));
  const firstSetup = !existsSync(paths.configPath);
  if (firstSetup) {
    const silent = { ...runtime, stdout: () => undefined };
    await initializeConfiguration(initArgs(args), silent, false);
    paths = resolveConfigPaths(runtime.env, option(args, "--config"));
  }
  const id = await ensureMachineId(paths.machineIdPath);
  let config = await pullManaged(
    await loadUserConfig(paths.configPath),
    paths.configPath,
  );
  if (!firstSetup) {
    const syncRepository = option(args, "--sync");
    const repository = syncRepository || option(args, "--repository");
    const storage = syncRepository
      ? "managed"
      : option(args, "--storage") || (repository ? "managed" : undefined);
    if (
      (storage && storage !== config.storage.mode) ||
      (repository && repository !== config.storage.repository) ||
      args.includes("--path")
    ) {
      throw new Error(
        "storage is already configured; storage options only apply on first setup",
      );
    }
  }
  const selectedProfile =
    option(args, "--profile") || config.machines[id]?.profile || "default";
  if (!config.profiles[selectedProfile]) {
    throw new Error(`profile ${selectedProfile} does not exist`);
  }
  const name = await machineName(args, runtime);
  config.machines[id] = { profile: selectedProfile, name };
  const depthValue = Number(option(args, "--depth") || "3");
  if (!Number.isInteger(depthValue) || depthValue < 1 || depthValue > 8) {
    throw new Error("--depth must be an integer from 1 through 8");
  }
  const explicitWorkspace = positionalWorkspace(args);
  let existingWorkspaces: LocalMachine["workspaces"] = [];
  try {
    existingWorkspaces = (await loadLocalMachine(paths.machinePath)).workspaces;
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !error.message.includes("run skilloom setup")
    ) {
      throw error;
    }
  }
  const workspaces = explicitWorkspace
    ? [
        ...existingWorkspaces.filter(
          (workspace) =>
            workspace.path !== workspacePath(explicitWorkspace, runtime),
        ),
        { path: workspacePath(explicitWorkspace, runtime), depth: depthValue },
      ]
    : existingWorkspaces.length > 0
      ? existingWorkspaces
      : defaultWorkspaces(runtime).map((path) => ({
          path,
          depth: depthValue,
        }));
  const machine: LocalMachine = { id, name, workspaces };
  await saveLocalMachine(paths.machinePath, machine);

  const managed = await loadManagedState(paths.statePath);
  const skills = new SkillsAdapter(runtime.run);
  const observed = new Map<string, InstalledSkill[]>();
  const dependencies = {
    listSkills: async (
      scope: "global" | "project",
      cwd: string,
      env: NodeJS.ProcessEnv,
    ) => {
      const key = `${scope}:${cwd}`;
      if (!observed.has(key))
        observed.set(key, await skills.list(scope, cwd, env));
      return observed.get(key)!;
    },
    projectRemote: async (cwd: string) => {
      const result = await runtime.run(
        "git",
        ["config", "--get", "remote.origin.url"],
        { cwd, env: runtime.env },
      );
      return result.code === 0 && result.stdout.trim()
        ? result.stdout.trim()
        : null;
    },
  };
  let inventory = await buildInventory(
    { machine, config, managed, cwd: runtime.cwd, env: runtime.env },
    dependencies,
  );

  let adopted = 0;
  let unmanaged = 0;
  const shouldAdopt = !args.includes("--no-adopt");
  const adopt = (
    installed: InstalledSkill,
    requirements: Array<{ source: string; name: string; agents: string[] }>,
    projectRoots: string[] = [],
  ) => {
    if (
      !shouldAdopt ||
      !installed.source ||
      installed.agents.length === 0 ||
      (config.storage.mode === "managed" &&
        isLocalSkillSource(installed.source))
    ) {
      unmanaged += 1;
      return;
    }
    const stateKeys =
      installed.scope === "global"
        ? [managedStateKey(installed)]
        : projectRoots.map((root) => managedStateKey(installed, root));
    const alreadyManaged =
      stateKeys.length > 0 && stateKeys.every((key) => managed.has(key));
    const existing = requirements.find(
      (skill) => skill.name === installed.name,
    );
    if (
      existing &&
      (existing.source !== installed.source ||
        existing.agents.some((agent) => !installed.agents.includes(agent)))
    ) {
      unmanaged += 1;
      return;
    }
    if (!existing) {
      requirements.push({
        source: installed.source,
        name: installed.name,
        agents: [...installed.agents].sort(),
      });
    }
    for (const key of stateKeys) managed.add(key);
    if (!alreadyManaged) adopted += 1;
  };

  const profile = config.profiles[selectedProfile];
  if (!profile) throw new Error(`profile ${selectedProfile} does not exist`);
  for (const skill of inventory.globalSkills.filter(
    (skill) => skill.installed,
  )) {
    adopt(skill, profile.skills);
  }
  for (const project of inventory.projects) {
    const policy = config.projects[project.id] ?? { skills: [] };
    for (const skill of project.skills.filter((skill) => skill.installed)) {
      const instances = project.checkouts.map((checkout) =>
        checkout.skills?.find(
          (candidate) => candidate.name === skill.name && candidate.installed,
        ),
      );
      const consistent = instances.every(
        (candidate) =>
          candidate &&
          candidate.ownership !== "repository" &&
          candidate.source === skill.source &&
          candidate.agents.length === skill.agents.length &&
          skill.agents.every((agent) => candidate.agents.includes(agent)),
      );
      if (!consistent) {
        unmanaged += 1;
        continue;
      }
      adopt(
        skill,
        policy.skills,
        project.checkouts.map((checkout) => checkout.path),
      );
    }
    if (policy.skills.length > 0 || policy.profile)
      config.projects[project.id] = policy;
  }

  await saveUserConfig(paths.configPath, config);
  await saveManagedState(paths.statePath, managed);
  inventory = await buildInventory(
    { machine, config, managed, cwd: runtime.cwd, env: runtime.env },
    dependencies,
  );
  await saveInventorySnapshot(paths.inventoryPath, inventory);
  if (config.storage.mode === "managed") {
    await new GitAdapter().commitAndPush(
      dirname(paths.configPath),
      `Set up ${name}`,
    );
  }
  const payload = { inventory, adoption: { adopted, unmanaged } };
  runtime.stdout(
    json
      ? JSON.stringify({ ok: true, command: "setup", ...payload })
      : `${name}\n${inventory.discovery.projectsFound} project(s), ${adopted} adopted skill(s), ${unmanaged} unmanaged skill(s)`,
  );
  return 0;
}
