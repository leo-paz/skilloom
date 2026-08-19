import type {
  DesiredSkill,
  ProjectConfig,
  SkillRequirement,
  UserConfig,
} from "./types.js";

function addRequirements(
  output: Map<string, DesiredSkill>,
  requirements: SkillRequirement[],
  scope: "global" | "project",
  reason: string,
): void {
  for (const requirement of requirements) {
    const conflictKey = `${scope}:${requirement.name}`;
    const existing = output.get(conflictKey);
    if (existing && existing.source !== requirement.source) {
      throw new Error(
        `conflicting sources for ${scope} skill ${requirement.name}: ${existing.source} and ${requirement.source}`,
      );
    }
    if (existing) {
      existing.agents = [
        ...new Set([...existing.agents, ...requirement.agents]),
      ].sort();
      existing.reasons = [...new Set([...existing.reasons, reason])].sort();
    } else {
      output.set(conflictKey, {
        ...requirement,
        agents: [...requirement.agents].sort(),
        scope,
        reasons: [reason],
      });
    }
  }
}

export function resolveDesiredState(
  config: UserConfig,
  machineId: string,
  projectRoot?: string,
  manifest?: ProjectConfig,
): DesiredSkill[] {
  const output = new Map<string, DesiredSkill>();
  const machine = config.machines[machineId];
  if (!machine)
    throw new Error(`machine ${machineId} has no profile assignment`);
  const globalProfile = config.profiles[machine.profile];
  if (!globalProfile)
    throw new Error(
      `machine ${machineId} references missing profile ${machine.profile}`,
    );
  addRequirements(
    output,
    globalProfile.skills,
    "global",
    `machine profile ${machine.profile}`,
  );

  if (projectRoot) {
    const personal = config.projects[projectRoot];
    const profileName = manifest?.profile ?? personal?.profile;
    if (profileName) {
      const profile = config.projectProfiles[profileName];
      if (!profile)
        throw new Error(`project references missing profile ${profileName}`);
      addRequirements(
        output,
        profile.skills,
        "project",
        `project profile ${profileName}`,
      );
    }
    if (manifest)
      addRequirements(output, manifest.skills, "project", "project manifest");
    if (personal)
      addRequirements(
        output,
        personal.skills,
        "project",
        "personal project additions",
      );
  }

  return [...output.values()].sort((left, right) => {
    const scopeOrder = left.scope.localeCompare(right.scope);
    return (
      scopeOrder ||
      left.name.localeCompare(right.name) ||
      left.source.localeCompare(right.source)
    );
  });
}
