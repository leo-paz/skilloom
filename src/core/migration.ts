import { createHash } from "node:crypto";
import { managedStateKey } from "./plan.js";
import type {
  InventorySkill,
  MachineInventory,
  SkillRequirement,
  UserConfig,
} from "./types.js";

export interface MigrationRemoval {
  projectId: string;
  skill: SkillRequirement;
  reason: "repository-owned" | "divergent-checkouts";
  explanation: string;
  checkouts: string[];
}
export interface MigrationPreview {
  fingerprint: string;
  requirements: MigrationRemoval[];
  stateKeys: string[];
  blockers: string[];
}
function matches(
  skill: InventorySkill | undefined,
  requirement: SkillRequirement,
): boolean {
  return Boolean(
    skill?.installed &&
      skill.source === requirement.source &&
      requirement.agents.every((agent) => skill.agents.includes(agent)),
  );
}
/** Only removes observed legacy claims. Missing projects and explicit source edits remain intact. */
export function buildMigrationPreview(
  config: UserConfig,
  managed: ReadonlySet<string>,
  inventory: MachineInventory,
): MigrationPreview {
  const requirements: MigrationRemoval[] = [];
  const stateKeys = new Set<string>();
  const blockers =
    inventory.discovery.status === "incomplete"
      ? ["Workspace discovery is incomplete; restore access before migrating."]
      : [];
  for (const project of inventory.projects) {
    for (const requirement of config.projects[project.id]?.skills ?? []) {
      const observations = project.checkouts.map((checkout) => ({
        path: checkout.path,
        skill: checkout.skills?.find(
          (skill) => skill.name === requirement.name,
        ),
      }));
      if (
        !observations.length ||
        project.checkouts.some((checkout) => !checkout.skills)
      )
        continue;
      const matching = observations.filter((item) =>
        matches(item.skill, requirement),
      );
      const legacy = matching.some((item) =>
        managed.has(
          managedStateKey({ ...requirement, scope: "project" }, item.path),
        ),
      );
      if (!legacy) continue;
      const repository =
        matching.length === observations.length &&
        matching.every((item) => item.skill?.ownership === "repository");
      const divergent =
        observations.length > 1 &&
        matching.length > 0 &&
        matching.length < observations.length &&
        matching.every((item) => item.skill?.ownership === "personal");
      if (!repository && !divergent) continue;
      requirements.push({
        projectId: project.id,
        skill: structuredClone(requirement),
        reason: repository ? "repository-owned" : "divergent-checkouts",
        explanation: repository
          ? "Git owns this skill in every observed checkout; the personal requirement duplicates repository content."
          : "The legacy personal requirement matches only some independent checkouts and would spread that installation to the others.",
        checkouts: observations.map((item) => item.path),
      });
      for (const item of observations) {
        // Once this personal policy is dropped, every old source claim for the
        // observed name must be released, including independently installed variants.
        const prefix = `project:${encodeURIComponent(item.path)}:${requirement.name}:`;
        for (const key of managed)
          if (key.startsWith(prefix)) stateKeys.add(key);
      }
    }
    // Repository-owned installations need no personal ownership even without a policy entry.
    for (const checkout of project.checkouts)
      for (const skill of checkout.skills ?? []) {
        if (skill.ownership !== "repository") continue;
        const prefix = `project:${encodeURIComponent(checkout.path)}:${skill.name}:`;
        for (const key of managed)
          if (key.startsWith(prefix)) stateKeys.add(key);
      }
  }
  const result = { requirements, stateKeys: [...stateKeys].sort(), blockers };
  const fingerprint = createHash("sha256")
    .update(
      JSON.stringify({
        config,
        managed: [...managed].sort(),
        projects: inventory.projects,
        discovery: inventory.discovery,
        ...result,
      }),
    )
    .digest("hex");
  return { fingerprint, ...result };
}
