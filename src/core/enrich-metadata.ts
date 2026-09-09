import {
  createSkillMetadataReader,
  type SkillMetadata,
} from "./skill-metadata.js";
import { scanSkillUsage } from "./skill-usage.js";
import type { InventorySkill, MachineInventory } from "./types.js";

/** Hydrate declarations and observed usage without rediscovering or reconciling installations. */
export async function enrichInventoryMetadata(
  inventory: MachineInventory,
  env: NodeJS.ProcessEnv,
  cachePath: string,
  signal?: AbortSignal,
): Promise<MachineInventory> {
  signal?.throwIfAborted();
  const enriched = structuredClone(inventory);
  const readMetadata = createSkillMetadataReader(env);
  const work: Array<{ skill: InventorySkill; cwd: string }> = [];
  for (const skill of enriched.globalSkills) {
    if (skill.installed && !skill.metadata)
      work.push({ skill, cwd: env.HOME || env.USERPROFILE || "/" });
  }
  const projectOccurrences = new Map<string, InventorySkill[]>();
  for (const project of enriched.projects) {
    const occurrences: InventorySkill[] = [];
    for (const checkout of project.checkouts) {
      // Older snapshots only contain project aggregates. Inspect their known paths
      // without inventing per-checkout installation records.
      const skills =
        checkout.skills ??
        project.skills.map((skill) => structuredClone(skill));
      for (const skill of skills) {
        occurrences.push(skill);
        if (skill.installed && !skill.metadata)
          work.push({ skill, cwd: checkout.path });
      }
    }
    projectOccurrences.set(project.id, occurrences);
  }
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, work.length) }, async () => {
      while (next < work.length) {
        signal?.throwIfAborted();
        const item = work[next++]!;
        const metadata = await readMetadata(item.skill, item.cwd);
        signal?.throwIfAborted();
        item.skill.metadata = metadata;
      }
    }),
  );
  for (const project of enriched.projects) {
    for (const skill of project.skills) {
      if (skill.metadata) continue;
      const declarations = (projectOccurrences.get(project.id) ?? [])
        .filter((item) => item.name === skill.name && item.metadata)
        .map((item) => item.metadata!);
      if (!declarations.length) continue;
      const modes = new Set(declarations.map((item) => item.invocation));
      const variants = new Map<string, SkillMetadata["variants"][number]>();
      for (const declaration of declarations)
        for (const variant of declaration.variants)
          variants.set(JSON.stringify(variant), variant);
      skill.metadata = {
        source: "skill-declaration",
        invocation: modes.has("unknown")
          ? "unknown"
          : modes.size === 1
            ? declarations[0]!.invocation
            : "mixed",
        variants: [...variants.values()].slice(0, 128),
      };
    }
  }
  signal?.throwIfAborted();
  enriched.skillUsage = await scanSkillUsage({
    env,
    cachePath,
    knownSkills: [
      ...new Set([
        ...enriched.globalSkills.map((skill) => skill.name),
        ...enriched.projects.flatMap((project) =>
          [
            ...project.skills,
            ...project.checkouts.flatMap((checkout) => checkout.skills ?? []),
          ].map((skill) => skill.name),
        ),
      ]),
    ].map((name) => ({ name })),
    ...(signal ? { signal } : {}),
  });
  signal?.throwIfAborted();
  return enriched;
}
