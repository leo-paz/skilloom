import { type InventoryOccurrence, queryInventory } from "../core/query.js";
import type {
  HarnessUsageCoverage,
  SkillUsageScan,
} from "../core/skill-usage.js";
import type { MachineInventory } from "../core/types.js";
export interface LibraryEntry {
  name: string;
  occurrences: InventoryOccurrence[];
  sources: string[];
  ownership: string;
  machines: string[];
  invocation: string;
  usedBy: string[];
  usageMachines: Array<{
    id: string;
    name: string;
    status: string;
    observedAt?: string;
    harnesses?: HarnessUsageCoverage[] | undefined;
    backfill?: SkillUsageScan["backfill"];
  }>;
}
export interface LibraryFilters {
  query: string;
  machine: string;
  scope: string;
  ownership: string;
}
export function ownershipLabel(skill: InventoryOccurrence): string {
  return skill.ownership === "repository"
    ? "Git-owned"
    : skill.managed
      ? "Managed"
      : "Unmanaged";
}
function group(
  records: InventoryOccurrence[],
  usageMachines: LibraryEntry["usageMachines"],
): LibraryEntry[] {
  const grouped = new Map<string, InventoryOccurrence[]>();
  for (const record of records)
    grouped.set(record.name, [...(grouped.get(record.name) ?? []), record]);
  return [...grouped]
    .map(([name, occurrences]) => {
      const invocations = [
        ...new Set(
          occurrences.map((record) => {
            const mode = record.metadata?.invocation ?? "unknown";
            return mode === "both" ? "automatic" : mode;
          }),
        ),
      ];
      const owners = [...new Set(occurrences.map(ownershipLabel))];
      return {
        name,
        usageMachines,
        invocation:
          invocations.length === 1
            ? invocations[0]!
            : invocations.includes("unknown")
              ? "partial"
              : "mixed",
        usedBy: [
          ...new Set(
            occurrences.flatMap(
              (record) => record.usedBy?.map((usage) => usage.harness) ?? [],
            ),
          ),
        ].sort(),
        occurrences,
        sources: [
          ...new Set(occurrences.map((x) => x.source ?? "Unknown source")),
        ],
        ownership: owners.length === 1 ? owners[0]! : "Mixed",
        machines: [...new Set(occurrences.map((x) => x.machine.id))],
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
export function buildLibrary(inventory: MachineInventory): LibraryEntry[] {
  const machines = new Map(
    [inventory.machine, ...inventory.machines].map((machine) => [
      machine.id,
      machine,
    ]),
  );
  const usageMachines = [...machines.values()].map((machine) => {
    const snapshot =
      machine.id === inventory.machine.id
        ? inventory
        : inventory.remoteObservations?.find(
            (record) => record.machine.id === machine.id,
          );
    const usage =
      snapshot?.skillUsage?.version === 2 ? snapshot.skillUsage : undefined;
    return {
      id: machine.id,
      name: machine.name,
      status: usage?.coverage.status ?? "unscanned",
      harnesses: usage?.harnessCoverage,
      backfill: usage?.backfill,
      ...(usage ? { observedAt: usage.coverage.observedAt } : {}),
    };
  });
  return group(queryInventory(inventory), usageMachines);
}
export function filterLibrary(
  entries: LibraryEntry[],
  filters: LibraryFilters,
): LibraryEntry[] {
  const words = filters.query
    .toLocaleLowerCase()
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return group(
    entries
      .flatMap((entry) => entry.occurrences)
      .filter((record) => {
        const haystack = [
          record.name,
          record.source,
          record.machine.name,
          record.projectId,
          record.projectName,
          record.checkoutPath,
          ...record.agents,
        ]
          .join(" ")
          .toLocaleLowerCase();
        return (
          (filters.machine === "all" ||
            record.machine.id === filters.machine) &&
          (filters.scope === "all" || record.scope === filters.scope) &&
          (filters.ownership === "all" ||
            (filters.ownership === "unknown"
              ? !record.source
              : ownershipLabel(record).toLowerCase() === filters.ownership)) &&
          words.every((word) => haystack.includes(word))
        );
      }),
    (entries[0]?.usageMachines ?? []).filter(
      (machine) => filters.machine === "all" || machine.id === filters.machine,
    ),
  );
}
export function safeText(value: unknown): string {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
}
export function observedLabel(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? "Unknown"
    : `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export function invocationLabel(value: string): string {
  return (
    (
      {
        manual: "Manual",
        automatic: "Automatic",
        both: "Manual + automatic",
        disabled: "Disabled",
        mixed: "Mixed",
        partial: "Unknown",
        unknown: "Unknown",
      } as Record<string, string>
    )[value] ?? "Unknown"
  );
}
export function harnessLabel(value: string, compact = false): string {
  return (
    (
      {
        codex: compact ? "OAI" : "OpenAI",
        claude: compact ? "Cl" : "Claude",
        pi: "Pi",
      } as Record<string, string>
    )[value] ?? safeText(value)
  );
}

export function usageLabel(entry: LibraryEntry, compact = false): string {
  const collected = entry.usageMachines.filter(
    (machine) => machine.status !== "unscanned",
  );
  const partial =
    collected.length < entry.usageMachines.length ||
    collected.some((machine) => machine.status !== "complete");
  if (entry.usedBy.length) {
    const names = entry.usedBy
      .map((harness) => harnessLabel(harness, compact))
      .join(" ");
    return `${names}${partial && !compact ? " · partial" : ""}`;
  }
  return collected.length === 0
    ? "Unscanned"
    : partial
      ? "Partial"
      : "No match";
}
