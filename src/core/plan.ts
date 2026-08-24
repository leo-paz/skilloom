import type { DesiredSkill, InstalledSkill, PlanOperation } from "./types.js";

const desiredKey = (skill: { scope: string; name: string }) =>
  `${skill.scope}:${skill.name}`;

export function managedStateKey(
  skill: { scope: string; name: string; source: string | null },
  projectRoot?: string,
): string {
  if (skill.scope === "global") return `global:${skill.name}`;
  return `project:${encodeURIComponent(projectRoot || "")}:${skill.name}:${encodeURIComponent(skill.source || "")}`;
}

function isSatisfied(
  desired: DesiredSkill,
  installed: InstalledSkill,
): boolean {
  if (desired.scope !== installed.scope || desired.name !== installed.name)
    return false;
  if (installed.source && desired.source !== installed.source) return false;
  if (installed.agents.length === 0) return true;
  const installedAgents = new Set(installed.agents);
  return desired.agents.every((agent) => installedAgents.has(agent));
}

export function planChanges(
  desired: DesiredSkill[],
  installed: InstalledSkill[],
  managed: ReadonlySet<string>,
  projectRoot?: string,
): PlanOperation[] {
  const operations: PlanOperation[] = [];
  for (const skill of desired) {
    if (!installed.some((candidate) => isSatisfied(skill, candidate))) {
      operations.push({ kind: "add", skill, reasons: skill.reasons });
    }
  }
  const desiredKeys = new Set(desired.map(desiredKey));
  for (const skill of installed) {
    const stateKey = managedStateKey(skill, projectRoot);
    if (managed.has(stateKey) && !desiredKeys.has(desiredKey(skill))) {
      operations.push({
        kind: "remove",
        skill,
        reasons: ["no longer desired"],
      });
    }
  }
  return operations.sort((left, right) => {
    const kindOrder = left.kind.localeCompare(right.kind);
    return (
      kindOrder ||
      left.skill.scope.localeCompare(right.skill.scope) ||
      left.skill.name.localeCompare(right.skill.name)
    );
  });
}
