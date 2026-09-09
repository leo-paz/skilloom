import { type InventoryOccurrence, queryInventory } from "../core/query.js";
import type { MachineInventory } from "../core/types.js";
export interface LibraryEntry {
  name: string;
  occurrences: InventoryOccurrence[];
  sources: string[];
  ownership: string;
  machines: string[];
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
function group(records: InventoryOccurrence[]): LibraryEntry[] {
  const grouped = new Map<string, InventoryOccurrence[]>();
  for (const record of records)
    grouped.set(record.name, [...(grouped.get(record.name) ?? []), record]);
  return [...grouped]
    .map(([name, occurrences]) => {
      const owners = [...new Set(occurrences.map(ownershipLabel))];
      return {
        name,
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
  return group(queryInventory(inventory));
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
