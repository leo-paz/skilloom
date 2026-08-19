export type Scope = "global" | "project";

export interface SkillRequirement {
  source: string;
  name: string;
  agents: string[];
}

export interface DesiredSkill extends SkillRequirement {
  scope: Scope;
  reasons: string[];
}

export interface InstalledSkill {
  name: string;
  source: string | null;
  agents: string[];
  scope: Scope;
}

export interface PlanOperation {
  kind: "add" | "remove";
  skill: DesiredSkill | InstalledSkill;
  reasons: string[];
}

export interface Profile {
  skills: SkillRequirement[];
}

export interface UserConfig {
  version: 1;
  storage: {
    mode: "local" | "external" | "managed";
    path?: string | undefined;
    repository?: string | undefined;
  };
  profiles: Record<string, Profile>;
  machines: Record<string, { profile: string }>;
  projectProfiles: Record<string, Profile>;
  projects: Record<
    string,
    { profile?: string | undefined; skills: SkillRequirement[] }
  >;
}

export interface ProjectConfig {
  version: 1;
  profile?: string | undefined;
  skills: SkillRequirement[];
}
