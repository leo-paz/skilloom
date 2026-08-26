import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, realpath } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { loadProjectConfig } from "./config.js";
import { managedStateKey, planChanges } from "./plan.js";
import { resolveDesiredState } from "./resolve.js";
import type {
  DesiredSkill,
  InstalledSkill,
  InventorySkill,
  LocalMachine,
  MachineInventory,
  PlanOperation,
  Scope,
  UserConfig,
  WorkspaceRoot,
} from "./types.js";

const ignoredDirectories = new Set([
  "node_modules",
  "vendor",
  "dist",
  "build",
  "coverage",
  "target",
  ".cache",
  ".next",
  ".turbo",
]);

export interface InventoryRequest {
  machine: LocalMachine;
  config: UserConfig;
  managed: ReadonlySet<string>;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface InventoryDependencies {
  listSkills: (
    scope: Scope,
    cwd: string,
    env: NodeJS.ProcessEnv,
  ) => Promise<InstalledSkill[]>;
  projectRemote: (cwd: string) => Promise<string | null>;
  now?: () => Date;
}

interface DiscoveredCheckout {
  path: string;
  remote: string | null;
  projectId: string;
  name: string;
}

interface RootResult {
  root: MachineInventory["discovery"]["roots"][number];
  checkouts: string[];
}

function normalizeRemote(remote: string): string {
  const trimmed = remote
    .trim()
    .replace(/\.git$/i, "")
    .replace(/\/$/, "");
  const scp = trimmed.match(/^(?:[^@]+@)?([^:]+):(.+)$/);
  if (scp?.[1] && scp[2] && !trimmed.includes("://")) {
    return `${scp[1].toLowerCase()}/${scp[2].replace(/^\//, "")}`;
  }
  try {
    const parsed = new URL(trimmed);
    return `${parsed.hostname.toLowerCase()}${parsed.pathname}`.replace(
      /\/$/,
      "",
    );
  } catch {
    return trimmed;
  }
}

async function localProjectId(path: string): Promise<string> {
  const canonical = await realpath(path);
  const hash = createHash("sha256")
    .update(canonical)
    .digest("hex")
    .slice(0, 12);
  return `local:${basename(path)}:${hash}`;
}

async function scanDirectory(
  path: string,
  depth: number,
  maximumDepth: number,
  output: string[],
): Promise<void> {
  if (existsSync(join(path, ".git"))) {
    output.push(path);
    return;
  }
  if (depth >= maximumDepth) return;
  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".") || ignoredDirectories.has(entry.name))
      continue;
    await scanDirectory(
      join(path, entry.name),
      depth + 1,
      maximumDepth,
      output,
    );
  }
}

async function scanRoot(workspace: WorkspaceRoot): Promise<RootResult> {
  const path = resolve(workspace.path);
  const root = { path, depth: workspace.depth } as RootResult["root"];
  const checkouts: string[] = [];
  try {
    await scanDirectory(path, 0, workspace.depth, checkouts);
    return { root: { ...root, status: "scanned" }, checkouts };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return {
      root: {
        ...root,
        status: code === "ENOENT" ? "missing" : "unreadable",
        detail: error instanceof Error ? error.message : String(error),
      },
      checkouts,
    };
  }
}

function inventorySkills(
  desired: DesiredSkill[],
  installed: InstalledSkill[],
  managed: ReadonlySet<string>,
  projectRoot?: string,
): InventorySkill[] {
  const entries = new Map<string, InventorySkill>();
  for (const skill of desired) {
    entries.set(`${skill.scope}:${skill.name}`, {
      name: skill.name,
      source: skill.source,
      agents: [...skill.agents],
      scope: skill.scope,
      installed: false,
      desired: true,
      managed: false,
      reasons: [...skill.reasons],
    });
  }
  for (const skill of installed) {
    const key = `${skill.scope}:${skill.name}`;
    const existing = entries.get(key);
    const isManaged = managed.has(managedStateKey(skill, projectRoot));
    if (existing) {
      existing.installed = true;
      existing.managed = isManaged;
      existing.source = skill.source ?? existing.source;
      existing.agents = [
        ...new Set([...existing.agents, ...skill.agents]),
      ].sort();
    } else {
      entries.set(key, {
        ...skill,
        agents: [...skill.agents].sort(),
        installed: true,
        desired: false,
        managed: isManaged,
        reasons: [],
      });
    }
  }
  return [...entries.values()].sort(
    (left, right) =>
      left.scope.localeCompare(right.scope) ||
      left.name.localeCompare(right.name),
  );
}

function operationKey(operation: PlanOperation): string {
  return `${operation.kind}:${operation.skill.scope}:${operation.skill.name}:${operation.skill.source ?? ""}`;
}

export async function buildInventory(
  request: InventoryRequest,
  dependencies: InventoryDependencies,
): Promise<MachineInventory> {
  const observedAt = (dependencies.now?.() ?? new Date()).toISOString();
  const rootResults = await Promise.all(
    request.machine.workspaces.map(scanRoot),
  );
  const checkoutPaths = [
    ...new Set(rootResults.flatMap((result) => result.checkouts)),
  ].sort();
  const discovered: DiscoveredCheckout[] = [];
  for (const path of checkoutPaths) {
    const remote = await dependencies.projectRemote(path);
    const projectId = remote
      ? normalizeRemote(remote)
      : await localProjectId(path);
    discovered.push({
      path,
      remote,
      projectId,
      name: basename(projectId.replace(/^local:/, "").split(":")[0] || path),
    });
  }

  const globalInstalled = await dependencies.listSkills(
    "global",
    request.cwd,
    request.env,
  );
  const globalDesired = resolveDesiredState(
    request.config,
    request.machine.id,
  ).filter((skill) => skill.scope === "global");
  const globalOperations = planChanges(
    globalDesired,
    globalInstalled,
    request.managed,
  );

  const grouped = new Map<string, DiscoveredCheckout[]>();
  for (const checkout of discovered) {
    const group = grouped.get(checkout.projectId) ?? [];
    group.push(checkout);
    grouped.set(checkout.projectId, group);
  }

  const projects: MachineInventory["projects"] = [];
  for (const [projectId, checkouts] of [...grouped.entries()].sort(
    ([left], [right]) => left.localeCompare(right),
  )) {
    const skills = new Map<string, InventorySkill>();
    const operations = new Map<string, PlanOperation>();
    const checkoutInventories: MachineInventory["projects"][number]["checkouts"] =
      [];
    for (const checkout of checkouts.sort((left, right) =>
      left.path.localeCompare(right.path),
    )) {
      const installed = await dependencies.listSkills(
        "project",
        checkout.path,
        request.env,
      );
      const manifest = await loadProjectConfig(
        join(checkout.path, ".skilloom.yaml"),
      );
      const desired = resolveDesiredState(
        request.config,
        request.machine.id,
        checkout.path,
        manifest,
        projectId,
      ).filter((skill) => skill.scope === "project");
      const checkoutSkills = inventorySkills(
        desired,
        installed,
        request.managed,
        checkout.path,
      );
      for (const item of checkoutSkills) {
        const key = `${item.scope}:${item.name}`;
        const existing = skills.get(key);
        if (!existing) skills.set(key, item);
        else {
          existing.installed ||= item.installed;
          existing.desired ||= item.desired;
          existing.managed ||= item.managed;
          existing.agents = [
            ...new Set([...existing.agents, ...item.agents]),
          ].sort();
          existing.reasons = [
            ...new Set([...existing.reasons, ...item.reasons]),
          ].sort();
        }
      }
      const checkoutOperations = planChanges(
        desired,
        installed,
        request.managed,
        checkout.path,
      );
      for (const operation of checkoutOperations) {
        operations.set(operationKey(operation), operation);
      }
      checkoutInventories.push({
        path: checkout.path,
        skills: checkoutSkills,
        operations: checkoutOperations,
      });
    }
    const first = checkouts[0];
    if (!first) continue;
    projects.push({
      id: projectId,
      name: first.name,
      remote: first.remote,
      checkouts: checkoutInventories,
      skills: [...skills.values()].sort((left, right) =>
        left.name.localeCompare(right.name),
      ),
      operations: [...operations.values()],
    });
  }

  const roots = rootResults.map((result) => result.root);
  const incomplete = roots.some((root) => root.status !== "scanned");
  const machineConfig = request.config.machines[request.machine.id];
  if (!machineConfig)
    throw new Error(`machine ${request.machine.id} has no profile assignment`);
  return {
    version: 1,
    observedAt,
    machine: {
      id: request.machine.id,
      name: request.machine.name,
      profile: machineConfig.profile,
    },
    discovery: {
      status: incomplete
        ? "incomplete"
        : projects.length > 0
          ? "found"
          : "empty",
      roots,
      projectsFound: projects.length,
      checkoutsFound: checkoutPaths.length,
    },
    profiles: Object.keys(request.config.profiles).sort(),
    machines: Object.entries(request.config.machines)
      .map(([id, machine]) => ({
        id,
        name: machine.name ?? id,
        profile: machine.profile,
        local: id === request.machine.id,
        ...(id === request.machine.id
          ? {
              observedAt,
              projects: projects.length,
              globalSkills: globalInstalled.length,
              changes:
                globalOperations.length +
                projects.reduce(
                  (total, project) => total + project.operations.length,
                  0,
                ),
            }
          : {}),
      }))
      .sort((left, right) => left.name.localeCompare(right.name)),
    globalSkills: inventorySkills(
      globalDesired,
      globalInstalled,
      request.managed,
    ),
    projects,
    operations: [
      ...globalOperations,
      ...projects.flatMap((project) => project.operations),
    ],
  };
}
