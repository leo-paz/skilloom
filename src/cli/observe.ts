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
    machines: inventory.machines.map((machine) => ({
      ...machine,
      observedAt: machine.local ? "" : machine.observedAt,
    })),
  });
}

function publishedObservation(
  inventory: MachineInventory,
): Record<string, unknown> {
  const publicSource = (source: string | null): string | null =>
    source && isLocalSkillSource(source) ? null : source;
  const publicSkill = <T extends { source: string | null }>(skill: T): T => ({
    ...skill,
    source: publicSource(skill.source),
  });
  const publicOperation = (
    operation: MachineInventory["operations"][number],
  ) => ({
    ...operation,
    skill: publicSkill(operation.skill),
  });
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
): Promise<number> {
  const configIndex = args.indexOf("--config");
  const explicitConfig = configIndex === -1 ? undefined : args[configIndex + 1];
  if (configIndex !== -1 && !explicitConfig)
    throw new Error("--config requires a value");
  const paths = resolveConfigPaths(runtime.env, explicitConfig);
  const current = await loadCurrentInventory(runtime, explicitConfig);
  const previous = await loadInventorySnapshot(paths.inventoryPath);
  const changed = !previous || comparable(previous) !== comparable(current);
  if (changed) await saveInventorySnapshot(paths.inventoryPath, current);
  else if (previous) current.observedAt = previous.observedAt;

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
    if (existing !== content) {
      await mkdir(dirname(observationPath), { recursive: true });
      await writeFile(observationPath, content, { mode: 0o600 });
      await new GitAdapter().commitAndPush(
        checkout,
        `Observe ${current.machine.name}`,
        [relative(checkout, observationPath)],
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
