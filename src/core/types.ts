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
  machines: Record<string, { profile: string; name?: string | undefined }>;
  projectProfiles: Record<string, Profile>;
  projects: Record<
    string,
    { profile?: string | undefined; skills: SkillRequirement[] }
  >;
}

export interface WorkspaceRoot {
  path: string;
  depth: number;
}

export interface LocalMachine {
  id: string;
  name: string;
  workspaces: WorkspaceRoot[];
}

export interface InventorySkill {
  name: string;
  source: string | null;
  agents: string[];
  scope: Scope;
  installed: boolean;
  desired: boolean;
  managed: boolean;
  reasons: string[];
}

export interface CheckoutInventory {
  path: string;
  skills?: InventorySkill[] | undefined;
  operations?: PlanOperation[] | undefined;
}

export interface ProjectInventory {
  id: string;
  name: string;
  remote: string | null;
  checkouts: CheckoutInventory[];
  skills: InventorySkill[];
  operations: PlanOperation[];
}

export interface MachineInventory {
  version: 1;
  observedAt: string;
  machine: { id: string; name: string; profile: string };
  discovery: {
    status: "found" | "empty" | "incomplete";
    roots: Array<{
      path: string;
      depth: number;
      status: "scanned" | "missing" | "unreadable";
      detail?: string | undefined;
    }>;
    projectsFound: number;
    checkoutsFound: number;
  };
  profiles: string[];
  machines: Array<{
    id: string;
    name: string;
    profile: string;
    local?: boolean | undefined;
    observedAt?: string | undefined;
    projects?: number | undefined;
    globalSkills?: number | undefined;
    changes?: number | undefined;
  }>;
  globalSkills: InventorySkill[];
  projects: ProjectInventory[];
  operations: PlanOperation[];
}

export interface ProjectConfig {
  version: 1;
  profile?: string | undefined;
  skills: SkillRequirement[];
}
