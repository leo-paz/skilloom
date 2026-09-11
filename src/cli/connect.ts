import { constants, existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { GitAdapter } from "../adapters/git.js";
import {
  ensureMachineId,
  loadUserConfig,
  resolveConfigPaths,
  saveUserConfig,
  writeLocator,
} from "../core/config.js";
import { isLocalSkillSource } from "../core/schema.js";
import type { UserConfig } from "../core/types.js";
import { initializeConfiguration } from "./configuration.js";
import type { CliRuntime } from "./runtime.js";

function mergeConfiguration(shared: UserConfig, local: UserConfig): UserConfig {
  const merged = structuredClone(shared);
  for (const section of [
    "profiles",
    "projectProfiles",
    "projects",
    "machines",
  ] as const) {
    const target: Record<string, unknown> = merged[section];
    for (const [key, value] of Object.entries(local[section])) {
      if (
        Object.hasOwn(target, key) &&
        !isDeepStrictEqual(target[key], value)
      ) {
        throw new Error(
          `cannot connect: conflicting ${section} entry ${key}; resolve the local and shared policy before connecting`,
        );
      }
      target[key] = value;
    }
  }
  const releases = new Map(
    (shared.ownershipReleases ?? []).map((release) => [release.id, release]),
  );
  for (const release of local.ownershipReleases ?? []) {
    const existing = releases.get(release.id);
    if (existing && !isDeepStrictEqual(existing, release))
      throw new Error(
        `cannot connect: conflicting ownership release ${release.id}`,
      );
    releases.set(release.id, release);
  }
  if (shared.version === 2 || local.version === 2) merged.version = 2;
  if (releases.size) merged.ownershipReleases = [...releases.values()];
  return merged;
}

function requirePortable(config: UserConfig): void {
  for (const release of config.ownershipReleases ?? []) {
    if (
      isLocalSkillSource(release.projectId) ||
      release.projectId.startsWith("local:")
    )
      throw new Error(
        "cannot connect: ownership releases contain local-only project identities",
      );
  }

  for (const [section, entries] of Object.entries({
    profiles: config.profiles,
    projectProfiles: config.projectProfiles,
    projects: config.projects,
  })) {
    for (const [key, entry] of Object.entries(entries)) {
      if (
        section === "projects" &&
        (isLocalSkillSource(key) || key.startsWith("local:"))
      ) {
        throw new Error(
          `cannot connect: project ${key} is local-only; remove its personal policy before sharing`,
        );
      }
      for (const skill of entry.skills) {
        if (isLocalSkillSource(skill.source)) {
          throw new Error(
            `cannot connect: ${section} ${key} skill ${skill.name} uses a local source; choose a portable repository source before sharing`,
          );
        }
      }
    }
  }
}

export async function connectConfiguration(
  args: string[],
  runtime: CliRuntime,
  json: boolean,
): Promise<number> {
  const repository = args[0];
  if (!repository || repository.startsWith("-"))
    throw new Error("connect requires a repository URL or path");
  if (args.includes("--config") || runtime.env.SKILLOOM_CONFIG)
    throw new Error(
      "connect uses the default configuration locator; unset SKILLOOM_CONFIG and omit --config before connecting",
    );
  const paths = resolveConfigPaths(runtime.env);
  if (!existsSync(paths.configPath)) {
    const machineId = await ensureMachineId(paths.machineIdPath);
    const checkout = join(paths.appDir, "repository");
    if (existsSync(checkout))
      throw new Error(
        `cannot connect: ${checkout} already exists; inspect the existing checkout before connecting`,
      );
    const staging = await mkdtemp(join(paths.appDir, "connect-"));
    const stagedApp = join(staging, "skilloom");
    try {
      await mkdir(stagedApp);
      await copyFile(paths.machineIdPath, join(stagedApp, "machine-id"));
      await initializeConfiguration(
        ["--storage", "managed", "--repository", repository],
        {
          ...runtime,
          env: { ...runtime.env, XDG_CONFIG_HOME: staging },
          stdout: () => {},
        },
        false,
      );
      await rename(join(stagedApp, "repository"), checkout);
      await writeLocator(paths.locatorPath, join(checkout, "config.yaml"));
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
    const configPath = join(checkout, "config.yaml");
    runtime.stdout(
      json
        ? JSON.stringify({
            ok: true,
            command: "connect",
            configPath,
            machineId,
            repository,
          })
        : `Connected ${configPath}`,
    );
    return 0;
  }
  const local = await loadUserConfig(paths.configPath);
  if (
    local.storage.mode === "managed" &&
    local.storage.repository === repository
  ) {
    runtime.stdout(
      json
        ? JSON.stringify({
            ok: true,
            command: "connect",
            configPath: paths.configPath,
            repository,
            alreadyConnected: true,
          })
        : `Already connected to ${repository}`,
    );
    return 0;
  }
  if (local.storage.mode !== "local")
    throw new Error(
      "connect migrates local storage; this configuration already uses external or managed storage",
    );
  requirePortable(local);
  const checkout = join(paths.appDir, "repository");
  if (existsSync(checkout))
    throw new Error(
      `cannot connect: ${checkout} already exists; inspect the existing checkout before connecting`,
    );
  await mkdir(paths.appDir, { recursive: true });
  const staging = await mkdtemp(join(paths.appDir, "connect-"));
  const git = new GitAdapter();
  try {
    await git.clone(repository, staging);
    const stagedConfig = join(staging, "config.yaml");
    const merged = existsSync(stagedConfig)
      ? mergeConfiguration(await loadUserConfig(stagedConfig), local)
      : structuredClone(local);
    requirePortable(merged);
    merged.storage = { mode: "managed", repository };
    const machineId = await ensureMachineId(paths.machineIdPath);
    if (!merged.machines[machineId])
      throw new Error(
        "local configuration has no profile assignment for this machine; run skilloom setup before connecting",
      );
    const backupPath = `${paths.configPath}.backup-${staging.slice(staging.lastIndexOf("-") + 1)}`;
    await copyFile(paths.configPath, backupPath, constants.COPYFILE_EXCL);
    await saveUserConfig(stagedConfig, merged);
    await git.commitAndPush(staging, `Connect machine ${machineId}`);
    await rename(staging, checkout);
    const configPath = join(checkout, "config.yaml");
    await writeLocator(paths.locatorPath, configPath);
    runtime.stdout(
      json
        ? JSON.stringify({
            ok: true,
            command: "connect",
            configPath,
            machineId,
            repository,
            backupPath,
          })
        : `Connected ${configPath}\nLocal configuration backup: ${backupPath}`,
    );
    return 0;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
