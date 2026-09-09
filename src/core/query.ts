import type { InventorySkill, MachineInventory, Scope } from "./types.js";

export interface InventoryQuery {
  machine?: string | undefined;
  scope?: Scope | undefined;
  source?: string | undefined;
  ownership?: "repository" | "personal" | "unknown" | undefined;
  query?: string | undefined;
}

export interface InventoryOccurrence extends InventorySkill {
  usedBy?:
    | Array<{
        harness: string;
        evidence: string;
        count: number;
        lastUsedAt: string;
      }>
    | undefined;
  usageCoverage?: string | undefined;
  machine: { id: string; name: string };
  observedAt: string;
  stale: boolean;
  projectId?: string | undefined;
  projectName?: string | undefined;
  checkoutPath?: string | undefined;
  checkoutId?: string | undefined;
}

/** Returns occurrences, preserving checkout ownership and snapshot boundaries. */
export function queryInventory(
  inventory: MachineInventory,
  query: InventoryQuery = {},
): InventoryOccurrence[] {
  const records: InventoryOccurrence[] = [];
  const local = {
    machine: inventory.machine,
    observedAt: inventory.observedAt,
    stale: inventory.cached === true,
  };
  for (const skill of inventory.globalSkills)
    records.push({
      ...skill,
      ownership: skill.ownership ?? "personal",
      ...local,
    });
  for (const project of inventory.projects) {
    const context = {
      ...local,
      projectId: project.id,
      projectName: project.name,
    };
    if (project.checkouts.some((checkout) => checkout.skills !== undefined)) {
      for (const checkout of project.checkouts) {
        for (const skill of checkout.skills ?? [])
          records.push({ ...skill, ...context, checkoutPath: checkout.path });
      }
    } else {
      // Legacy snapshots have only project aggregates. Do not infer checkout facts.
      for (const skill of project.skills)
        records.push({ ...skill, ...context });
    }
  }
  for (const observation of inventory.remoteObservations ?? []) {
    const context = {
      machine: observation.machine,
      observedAt: observation.observedAt,
      stale: true,
    };
    for (const skill of observation.globalSkills ?? [])
      records.push({ ...skill, ...context });
    for (const project of observation.projects) {
      const projectContext = {
        ...context,
        projectId: project.id,
        projectName: project.name,
      };
      if (project.checkouts !== undefined) {
        for (const checkout of project.checkouts) {
          for (const skill of checkout.skills)
            records.push({
              ...skill,
              ...projectContext,
              checkoutId: checkout.id,
            });
        }
      } else {
        for (const skill of project.skills)
          records.push({ ...skill, ...projectContext });
      }
    }
  }
  const usageByMachine = new Map<
    string,
    {
      coverage: string;
      skills: Map<string, NonNullable<InventoryOccurrence["usedBy"]>>;
    }
  >();
  for (const snapshot of [inventory, ...(inventory.remoteObservations ?? [])]) {
    if (!snapshot.skillUsage) continue;
    const skills = new Map<
      string,
      NonNullable<InventoryOccurrence["usedBy"]>
    >();
    for (const item of snapshot.skillUsage.usage) {
      const rows = skills.get(item.name) ?? [];
      rows.push(item);
      skills.set(item.name, rows);
    }
    usageByMachine.set(snapshot.machine.id, {
      coverage: snapshot.skillUsage.coverage.status,
      skills,
    });
  }
  for (const record of records) {
    const usage = usageByMachine.get(record.machine.id);
    if (usage) {
      record.usedBy = usage.skills.get(record.name) ?? [];
      record.usageCoverage = usage.coverage;
    }
  }
  const search = query.query?.toLowerCase();
  return records.filter(
    (record) =>
      (!query.machine ||
        query.machine === record.machine.id ||
        query.machine === record.machine.name) &&
      (!query.scope || record.scope === query.scope) &&
      (!query.source ||
        (query.source === "unknown"
          ? record.source === null
          : record.source === query.source)) &&
      (!query.ownership ||
        (record.ownership ?? "unknown") === query.ownership) &&
      (!search ||
        [
          record.name,
          record.source,
          record.machine.id,
          record.machine.name,
          record.projectId,
          record.projectName,
          record.checkoutPath,
          ...record.agents,
        ].some((value) => value?.toLowerCase().includes(search))),
  );
}
