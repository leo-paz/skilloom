import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { GitAdapter } from "../adapters/git.js";
import {
  loadInventorySnapshot,
  loadUserConfig,
  resolveConfigPaths,
  saveInventorySnapshot,
} from "../core/config.js";
import { isLocalSkillSource } from "../core/schema.js";
import type { MachineInventory } from "../core/types.js";
import { loadCurrentInventory } from "./inventory.js";
import type { CliRuntime } from "./runtime.js";

function comparable(inventory: MachineInventory): string {
  return JSON.stringify({
    ...inventory,
    observedAt: "",
    machines: inventory.machines
      .filter((machine) => machine.local)
      .map((machine) => ({ ...machine, observedAt: "" })),
  });
}

function comparablePublished(content: string): string {
  try {
    return JSON.stringify({ ...JSON.parse(content), observedAt: "" });
  } catch {
    return content;
  }
}

function publishedObservation(
  inventory: MachineInventory,
): Record<string, unknown> {
  const publicSource = (source: string | null): string | null =>
    source && isLocalSkillSource(source) ? null : source;
  const publicSkill = <
    T extends {
      source: string | null;
      desiredSource?: string | null | undefined;
      path?: string | undefined;
    },
  >(
    skill: T,
  ) => {
    const { path: _path, ...safe } = skill;
    return {
      ...safe,
      source: publicSource(skill.source),
      ...(skill.desiredSource !== undefined
        ? { desiredSource: publicSource(skill.desiredSource) }
        : {}),
    };
  };
  const publicOperation = (
    operation: MachineInventory["operations"][number],
  ) => {
    const { checkoutPath: _checkoutPath, ...safe } = operation;
    return { ...safe, skill: publicSkill(operation.skill) };
  };
  return {
    version: inventory.version,
    observedAt: inventory.observedAt,
    machine: inventory.machine,
    discovery: {
      status: inventory.discovery.status,
      projectsFound: inventory.discovery.projectsFound,
      checkoutsFound: inventory.discovery.checkoutsFound,
    },
    profiles: inventory.profiles,
    globalSkills: inventory.globalSkills.map(publicSkill),
    projects: inventory.projects.map((project) => ({
      id: project.id,
      name: project.name,
      remote: publicSource(project.remote),
      checkoutCount: project.checkouts.length,
      ...(project.checkouts.every((checkout) => checkout.skills !== undefined)
        ? {
            checkouts: project.checkouts.map((checkout) => ({
              id: createHash("sha256")
                .update(
                  `${inventory.machine.id}\0${project.id}\0${checkout.path}`,
                )
                .digest("hex")
                .slice(0, 20),
              skills: checkout.skills!.map(publicSkill),
              ...(checkout.branch ? { branch: checkout.branch } : {}),
              ...(checkout.commit ? { commit: checkout.commit } : {}),
            })),
          }
        : {}),
      skills: project.skills.map(publicSkill),
      operations: project.operations.map(publicOperation),
    })),
    operations: inventory.operations.map(publicOperation),
  };
}

export async function observeMachine(
  args: string[],
  runtime: CliRuntime,
  json: boolean,
  currentInventory?: MachineInventory,
): Promise<number> {
  const configIndex = args.indexOf("--config");
  const explicitConfig = configIndex === -1 ? undefined : args[configIndex + 1];
  if (configIndex !== -1 && !explicitConfig)
    throw new Error("--config requires a value");
  const paths = resolveConfigPaths(runtime.env, explicitConfig);
  const current =
    currentInventory ?? (await loadCurrentInventory(runtime, explicitConfig));
  const previous = await loadInventorySnapshot(paths.inventoryPath);
  const changed = !previous || comparable(previous) !== comparable(current);
  if (!changed && previous) current.observedAt = previous.observedAt;
  // Refresh remote metadata in the local cache without republishing local status.
  await saveInventorySnapshot(paths.inventoryPath, current);

  let published = false;
  if (args.includes("--publish")) {
    const config = await loadUserConfig(paths.configPath);
    if (config.storage.mode !== "managed") {
      throw new Error("observe --publish requires managed Git storage");
    }
    const checkout = dirname(paths.configPath);
    const observationPath = join(
      checkout,
      "observations",
      `${current.machine.id}.json`,
    );
    const content = `${JSON.stringify(publishedObservation(current), null, 2)}\n`;
    const existing = existsSync(observationPath)
      ? await readFile(observationPath, "utf8")
      : undefined;
    if (
      !existing ||
      comparablePublished(existing) !== comparablePublished(content)
    ) {
      await mkdir(dirname(observationPath), { recursive: true });
      await writeFile(observationPath, content, { mode: 0o600 });
      await new GitAdapter().commitObservationAndPush(
        checkout,
        `Observe ${current.machine.name}`,
        relative(checkout, observationPath),
      );
      published = true;
    }
  }
  runtime.stdout(
    json
      ? JSON.stringify({
          ok: true,
          command: "observe",
          changed,
          published,
          observedAt: current.observedAt,
          machine: current.machine,
        })
      : `${current.machine.name}: ${changed ? "inventory changed" : "no inventory change"}${published ? ", published" : ""}`,
  );
  return 0;
}
