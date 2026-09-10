import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";
import { GitAdapter } from "../adapters/git.js";
import { SkillsAdapter } from "../adapters/skills.js";
import {
  findProjectRoot,
  loadInventorySnapshot,
  loadLocalMachine,
  loadMachineId,
  loadManagedState,
  loadUserConfig,
  resolveConfigPaths,
} from "../core/config.js";
import { installationDirectorySchema } from "../core/installation-directories.js";
import { buildInventory } from "../core/inventory.js";
import { type InventoryQuery, queryInventory } from "../core/query.js";
import { skillMetadataSchema } from "../core/skill-metadata.js";
import { scanSkillUsage, skillUsageScanSchema } from "../core/skill-usage.js";
import type {
  LocalMachine,
  MachineInventory,
  UserConfig,
} from "../core/types.js";
import { prepareUsagePaths } from "../core/usage-paths.js";
import type { CliRuntime } from "./runtime.js";

const observedSkill = z.object({
  installationDirectories: z
    .array(installationDirectorySchema)
    .max(128)
    .optional(),
  metadata: skillMetadataSchema.optional(),
  usagePathIds: z.array(z.string().regex(/^[a-f0-9]{64}$/)).optional(),
  name: z.string(),
  source: z.string().nullable(),
  scope: z.enum(["global", "project"]),
  agents: z.array(z.string()),
  installed: z.boolean(),
  desired: z.boolean(),
  managed: z.boolean(),
  reasons: z.array(z.string()),
  ownership: z.enum(["repository", "personal"]).optional(),
  conflict: z.string().optional(),
  detectedAgents: z.array(z.string()).optional(),
  desiredSource: z.string().nullable().optional(),
  desiredAgents: z.array(z.string()).optional(),
});

const remoteProjects = z.array(
  z.object({
    id: z.string(),
    name: z.string(),
    skills: z.array(observedSkill),
    checkouts: z
      .array(
        z.object({
          id: z.string().min(1),
          skills: z.array(observedSkill),
          branch: z.string().optional(),
          commit: z.string().optional(),
        }),
      )
      .optional(),
  }),
);

async function pullManaged(
  config: UserConfig,
  configPath: string,
  signal?: AbortSignal,
): Promise<UserConfig> {
  if (config.storage.mode !== "managed") return config;
  await new GitAdapter().pull(dirname(configPath), signal);
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

export interface InventoryOptions extends InventoryQuery {
  cached?: boolean | undefined;
}

export async function loadCurrentInventory(
  runtime: CliRuntime,
  explicitConfigPath?: string,
  options: InventoryOptions = {},
): Promise<MachineInventory> {
  const paths = resolveConfigPaths(runtime.env, explicitConfigPath);
  if (options.cached) {
    const cached = await loadInventorySnapshot(paths.inventoryPath);
    if (!cached)
      throw new Error("No cached inventory; run skilloom observe first.");
    cached.cached = true;
    return cached;
  }
  const config = await pullManaged(
    await loadUserConfig(paths.configPath),
    paths.configPath,
    runtime.signal,
  );
  const machine = await localMachine(
    runtime,
    paths.machinePath,
    paths.machineIdPath,
    config,
  );
  const managed = await loadManagedState(paths.statePath);
  const skills = new SkillsAdapter(runtime.run, undefined, runtime.signal);
  const inventory = await buildInventory(
    { machine, config, managed, cwd: runtime.cwd, env: runtime.env },
    {
      onProgress: runtime.onProgress,
      listSkills: (scope, cwd, env) => skills.list(scope, cwd, env),
      projectRemote: async (cwd) => {
        const result = await runtime.run(
          "git",
          ["config", "--get", "remote.origin.url"],
          { cwd, env: runtime.env, signal: runtime.signal },
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
          projects?: unknown;
          skillUsage?: unknown;
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
        const projects = remoteProjects.safeParse(observed.projects);
        const globals = z.array(observedSkill).safeParse(observed.globalSkills);
        const usage = skillUsageScanSchema.safeParse(observed.skillUsage);
        if (projects.success) {
          inventory.remoteObservations ??= [];
          inventory.remoteObservations.push({
            machine: { id: machine.id, name: machine.name },
            observedAt: observed.observedAt,
            stale: true,
            ...(usage.success ? { skillUsage: usage.data } : {}),
            ...(globals.success ? { globalSkills: globals.data } : {}),
            projects: projects.data,
          });
        }
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
  runtime.signal?.throwIfAborted();
  runtime.onProgress?.({ phase: "usage", completed: 0, total: 1 });
  inventory.skillUsage = await scanSkillUsage({
    env: runtime.env,
    cachePath: join(dirname(paths.inventoryPath), "skill-usage-cache.json"),
    knownSkills: await prepareUsagePaths(
      inventory,
      runtime.env,
      runtime.signal,
    ),
    ...(runtime.signal ? { signal: runtime.signal } : {}),
  });
  runtime.onProgress?.({ phase: "usage", completed: 1, total: 1 });
  return inventory;
}

export async function showInventory(
  runtime: CliRuntime,
  json: boolean,
  explicitConfigPath?: string,
  options: InventoryOptions = {},
): Promise<number> {
  const inventory = await loadCurrentInventory(
    runtime,
    explicitConfigPath,
    options,
  );
  const records = queryInventory(inventory, options);
  const installed =
    inventory.globalSkills.filter((skill) => skill.installed).length +
    inventory.projects.reduce(
      (total, project) =>
        total + project.skills.filter((skill) => skill.installed).length,
      0,
    );
  runtime.stdout(
    json
      ? JSON.stringify({
          ok: true,
          command: "inventory",
          ...inventory,
          records,
        })
      : [
          `${inventory.machine.name} · ${inventory.machine.profile}${inventory.cached ? ` · cached ${inventory.observedAt}` : ""}`,
          `${inventory.discovery.projectsFound} project(s) · ${installed} installed skill(s) · ${inventory.operations.length} change(s)`,
          ...records.map(
            (record) =>
              `${record.name} · ${record.source ?? "unknown source"} · ${record.machine.name} · ${record.scope} · ${record.ownership ?? "unknown ownership"}${record.projectName ? ` · ${record.projectName}` : ""}${record.checkoutPath ? ` · ${record.checkoutPath}` : record.checkoutId ? ` · checkout ${record.checkoutId}` : ""}${record.stale ? ` · stale snapshot ${record.observedAt}` : ""}`,
          ),
        ].join("\n"),
  );
  return 0;
}
