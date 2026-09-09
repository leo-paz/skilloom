import type { SkillMetadata } from "./skill-metadata.js";
import type { SkillUsageScan } from "./skill-usage.js";
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
  metadata?: SkillMetadata | undefined;
  detectedAgents?: string[] | undefined;
  missing?: boolean | undefined;
  path?: string | undefined;
  repositoryOwned?: boolean | undefined;
  name: string;
  source: string | null;
  agents: string[];
  scope: Scope;
}

export interface PlanOperation {
  checkoutPath?: string | undefined;
  kind: "add" | "remove";
  skill: DesiredSkill | InstalledSkill;
  reasons: string[];
}

export interface Profile {
  skills: SkillRequirement[];
}

export interface OwnershipRelease {
  id: string;
  projectId: string;
  name: string;
}

export interface OwnershipReleaseDelta {
  releasedKeys: string[];
  acknowledgedKeys: string[];
}

export interface UserConfig {
  version: 1 | 2;
  ownershipReleases?: OwnershipRelease[] | undefined;
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
  metadata?: SkillMetadata | undefined;
  detectedAgents?: string[] | undefined;
  ownership?: "repository" | "personal" | undefined;
  desiredSource?: string | null | undefined;
  desiredAgents?: string[] | undefined;
  conflict?: string | undefined;
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
  branch?: string | undefined;
  commit?: string | undefined;
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

export interface InventoryProgress {
  phase: string;
  path?: string | undefined;
  completed: number;
  total: number;
}

export interface MachineInventory {
  skillUsage?: SkillUsageScan | undefined;
  ownershipRelease?: OwnershipReleaseDelta | undefined;
  cached?: boolean | undefined;
  remoteObservations?:
    | Array<{
        machine: { id: string; name: string };
        observedAt: string;
        stale?: boolean | undefined;
        skillUsage?: SkillUsageScan | undefined;
        globalSkills?: InventorySkill[] | undefined;
        projects: Array<{
          id: string;
          name: string;
          skills: InventorySkill[];
          checkouts?:
            | Array<{
                id: string;
                skills: InventorySkill[];
                branch?: string | undefined;
                commit?: string | undefined;
              }>
            | undefined;
        }>;
      }>
    | undefined;
  version: 1;
  observedAt: string;
  machine: { id: string; name: string; profile: string };
  discovery: {
    excludedWorktrees?: number | undefined;
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
