import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { GitAdapter } from "../adapters/git.js";
import {
  ensureMachineId,
  findProjectRoot,
  loadProjectConfig,
  loadUserConfig,
  resolveConfigPaths,
  saveProjectConfig,
  saveUserConfig,
  writeLocator,
} from "../core/config.js";
import { isLocalSkillSource, isValidSkillSource } from "../core/schema.js";
import type { UserConfig } from "../core/types.js";
import type { CliRuntime } from "./runtime.js";

function flag(args: string[], name: string): boolean {
  return args.includes(name);
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--"))
    throw new Error(`${name} requires a value`);
  return value;
}

function requireIdentifier(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    throw new Error(`${label} must be a plain identifier`);
  }
  return value;
}

function requireSource(value: string): string {
  if (!isValidSkillSource(value)) {
    throw new Error("source contains unsafe characters");
  }
  return value;
}

function emit(
  runtime: CliRuntime,
  json: boolean,
  command: string,
  data: Record<string, unknown>,
  text: string,
): void {
  runtime.stdout(json ? JSON.stringify({ ok: true, command, ...data }) : text);
}

async function pullManagedConfig(
  config: UserConfig,
  configPath: string,
): Promise<UserConfig> {
  if (config.storage.mode !== "managed") return config;
  await new GitAdapter().pull(dirname(configPath));
  return loadUserConfig(configPath);
}

export async function initializeConfiguration(
  args: string[],
  runtime: CliRuntime,
  json: boolean,
): Promise<number> {
  const storage = option(args, "--storage") || "local";
  if (!(["local", "external", "managed"] as string[]).includes(storage)) {
    throw new Error(`unknown storage mode ${storage}`);
  }
  const basePaths = resolveConfigPaths(runtime.env, option(args, "--config"));
  let configPath = basePaths.configPath;
  let repository: string | undefined;
  let existingManagedCheckout = false;
  if (storage === "external") {
    configPath = resolve(
      runtime.cwd,
      option(args, "--path") ||
        (() => {
          throw new Error("external storage requires --path");
        })(),
    );
  }
  if (storage === "managed") {
    repository = option(args, "--repository");
    if (!repository) throw new Error("managed storage requires --repository");
    const checkout = join(basePaths.appDir, "repository");
    existingManagedCheckout = existsSync(checkout);
    if (!existingManagedCheckout)
      await new GitAdapter().clone(repository, checkout);
    configPath = join(checkout, "config.yaml");
  }
  const machineId = await ensureMachineId(basePaths.machineIdPath);
  if (existsSync(configPath) && !flag(args, "--force")) {
    if (storage === "local")
      throw new Error(`configuration already exists at ${configPath}`);
    if (storage === "managed" && existingManagedCheckout) {
      await new GitAdapter().pull(dirname(configPath));
    }
    const existing = await loadUserConfig(configPath);
    const preservedProfile = option(args, "--preserve-global-profile");
    if (preservedProfile) {
      requireIdentifier(preservedProfile, "profile name");
      if (existing.profiles[preservedProfile])
        throw new Error(
          `profile ${preservedProfile} already exists; choose a new machine profile name`,
        );
      existing.profiles[preservedProfile] = { skills: [] };
    }
    const profile =
      preservedProfile ||
      option(args, "--profile") ||
      (existing.profiles.default
        ? "default"
        : Object.keys(existing.profiles)[0]);
    if (!profile || !existing.profiles[profile]) {
      throw new Error("existing configuration has no selectable profile");
    }
    existing.storage = {
      mode: storage as "external" | "managed",
      ...(repository ? { repository } : {}),
    };
    existing.machines[machineId] = { profile };
    await saveUserConfig(configPath, existing);
    await writeLocator(basePaths.locatorPath, configPath);
    if (storage === "managed") {
      await new GitAdapter().commitAndPush(
        dirname(configPath),
        `Connect machine ${machineId}`,
      );
    }
    emit(
      runtime,
      json,
      "init",
      { configPath, machineId, storage, connected: true },
      `Connected ${configPath}`,
    );
    return 0;
  }
  const config: UserConfig = {
    version: 1,
    storage: {
      mode: storage as "local" | "external" | "managed",
      ...(repository ? { repository } : {}),
    },
    profiles: { default: { skills: [] } },
    machines: { [machineId]: { profile: "default" } },
    projectProfiles: {},
    projects: {},
  };
  const preservedProfile = option(args, "--preserve-global-profile");
  if (preservedProfile) {
    requireIdentifier(preservedProfile, "profile name");
    if (config.profiles[preservedProfile])
      throw new Error(
        `profile ${preservedProfile} already exists; choose a new machine profile name`,
      );
    config.profiles[preservedProfile] = { skills: [] };
    config.machines[machineId] = { profile: preservedProfile };
  }
  await saveUserConfig(configPath, config);
  if (storage !== "local")
    await writeLocator(basePaths.locatorPath, configPath);
  if (storage === "managed")
    await new GitAdapter().commitAndPush(
      dirname(configPath),
      "Initialize Skilloom configuration",
    );
  emit(
    runtime,
    json,
    "init",
    { configPath, machineId, storage },
    `Initialized ${configPath}`,
  );
  return 0;
}

export async function initializeProject(
  args: string[],
  runtime: CliRuntime,
  json: boolean,
): Promise<number> {
  const root = findProjectRoot(runtime.cwd);
  if (!root) throw new Error("project init must run inside a Git repository");
  const path = join(root, ".skilloom.yaml");
  if (existsSync(path) && !flag(args, "--force"))
    throw new Error(`${path} already exists`);
  await saveProjectConfig(path, { version: 1, skills: [] });
  emit(runtime, json, "project init", { path }, `Created ${path}`);
  return 0;
}

export async function editProject(
  command: "add" | "remove",
  args: string[],
  runtime: CliRuntime,
  json: boolean,
): Promise<number> {
  const root = findProjectRoot(runtime.cwd);
  if (!root)
    throw new Error(`project ${command} must run inside a Git repository`);
  const path = join(root, ".skilloom.yaml");
  const existingManifest = await loadProjectConfig(path);
  const manifest =
    existingManifest ??
    (command === "add" ? { version: 1 as const, skills: [] } : undefined);
  if (!manifest)
    throw new Error(`project skill policy does not exist at ${path}`);
  const nameValue = option(args, "--skill");
  if (!nameValue) throw new Error(`project ${command} requires --skill`);
  const name = requireIdentifier(nameValue, "skill name");
  if (command === "add") {
    const sourceValue = option(args, "--source");
    if (!sourceValue) throw new Error("project add requires --source");
    const source = requireSource(sourceValue);
    if (manifest.skills.some((skill) => skill.name === name)) {
      throw new Error(`project skill ${name} already exists`);
    }
    const agents = [
      ...new Set(
        (option(args, "--agents") || option(args, "--agent") || "codex")
          .split(",")
          .map((agent) => requireIdentifier(agent.trim(), "agent")),
      ),
    ].sort();
    manifest.skills.push({ source, name, agents });
  } else {
    const next = manifest.skills.filter((skill) => skill.name !== name);
    if (next.length === manifest.skills.length) {
      throw new Error(`project skill ${name} does not exist`);
    }
    manifest.skills = next;
  }
  await saveProjectConfig(path, manifest);
  emit(
    runtime,
    json,
    `project ${command}`,
    { path, skill: name },
    `${command === "add" ? "Added" : "Removed"} ${name} ${command === "add" ? "to" : "from"} ${path}`,
  );
  return 0;
}

export async function configureProfiles(
  args: string[],
  runtime: CliRuntime,
  json: boolean,
): Promise<number> {
  const paths = resolveConfigPaths(runtime.env, option(args, "--config"));
  const machineId = await ensureMachineId(paths.machineIdPath);
  let config = await loadUserConfig(paths.configPath);
  config = await pullManagedConfig(config, paths.configPath);
  const addProfile = option(args, "--add-profile");
  const removeProfile = option(args, "--remove-profile");
  const addSkill = option(args, "--add-skill");
  const removeSkill = option(args, "--remove-skill");
  if (addProfile) {
    const name = requireIdentifier(addProfile, "profile name");
    if (config.profiles[name])
      throw new Error(`profile ${name} already exists`);
    const copyProfile = option(args, "--copy-profile");
    if (copyProfile && !config.profiles[copyProfile])
      throw new Error(`profile ${copyProfile} does not exist`);
    config.profiles[name] = copyProfile
      ? structuredClone(config.profiles[copyProfile]!)
      : { skills: [] };
  }
  if (removeProfile) {
    const name = requireIdentifier(removeProfile, "profile name");
    if (!config.profiles[name])
      throw new Error(`profile ${name} does not exist`);
    if (
      Object.values(config.machines).some((machine) => machine.profile === name)
    ) {
      throw new Error(`profile ${name} is assigned to a machine`);
    }
    delete config.profiles[name];
  }
  if (addSkill) {
    const name = requireIdentifier(addSkill, "skill name");
    const profileName = option(args, "--to-profile");
    const sourceValue = option(args, "--source");
    if (!profileName || !config.profiles[profileName]) {
      throw new Error("config --add-skill requires an existing --to-profile");
    }
    if (!sourceValue) throw new Error("config --add-skill requires --source");
    if (config.storage.mode === "managed" && isLocalSkillSource(sourceValue))
      throw new Error(
        "managed configuration cannot publish local skill sources; use a repository source",
      );
    if (
      config.profiles[profileName].skills.some((skill) => skill.name === name)
    ) {
      throw new Error(`profile ${profileName} already contains skill ${name}`);
    }
    config.profiles[profileName].skills.push({
      source: requireSource(sourceValue),
      name,
      agents: [requireIdentifier(option(args, "--agent") || "codex", "agent")],
    });
  }
  if (removeSkill) {
    const name = requireIdentifier(removeSkill, "skill name");
    const profileName = option(args, "--from-profile");
    if (!profileName || !config.profiles[profileName]) {
      throw new Error(
        "config --remove-skill requires an existing --from-profile",
      );
    }
    const next = config.profiles[profileName].skills.filter(
      (skill) => skill.name !== name,
    );
    if (next.length === config.profiles[profileName].skills.length) {
      throw new Error(`profile ${profileName} does not contain skill ${name}`);
    }
    config.profiles[profileName].skills = next;
  }
  const profile = option(args, "--profile");
  if (profile) {
    if (!config.profiles[profile])
      throw new Error(`profile ${profile} does not exist`);
    config.machines[machineId] = { ...config.machines[machineId], profile };
  }
  if (profile || addProfile || removeProfile || addSkill || removeSkill) {
    await saveUserConfig(paths.configPath, config);
    if (config.storage.mode === "managed") {
      await new GitAdapter().commitAndPush(
        dirname(paths.configPath),
        "Update Skilloom profiles",
      );
    }
  }
  emit(
    runtime,
    json,
    "config",
    {
      configPath: paths.configPath,
      machineId,
      profile: config.machines[machineId]?.profile,
    },
    `${paths.configPath}\nMachine ${machineId}: ${config.machines[machineId]?.profile || "unassigned"}`,
  );
  return 0;
}
