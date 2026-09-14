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
  owners: string[];
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
    ? "Git"
    : skill.managed
      ? "Skilloom"
      : "External";
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
          occurrences
            .filter((record) => record.installed)
            .map((record) => {
              const mode = record.metadata?.invocation ?? "unknown";
              return mode === "both" ? "automatic" : mode;
            }),
        ),
      ];
      const presentOwners = new Set(occurrences.map(ownershipLabel));
      // Summarize the strongest ownership boundary; preserve all owners for details.
      const owners = ["Git", "Skilloom", "External"].filter((owner) =>
        presentOwners.has(owner),
      );
      return {
        name,
        usageMachines,
        invocation:
          invocations.length === 0
            ? "not-installed"
            : invocations.length === 1
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
        ownership: owners[0]!,
        owners,
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
export interface LibrarySourceGroup {
  key: string;
  label: string;
  entries: LibraryEntry[];
}
/** Group only recorded skill origins; a checkout repository is not provenance. */
export function groupLibraryBySource(
  entries: LibraryEntry[],
): LibrarySourceGroup[] {
  const sources = new Map<
    string,
    { label: string; records: InventoryOccurrence[] }
  >();
  for (const entry of entries)
    for (const record of entry.occurrences) {
      const source = record.source?.trim();
      const github = source?.match(
        /^(?:(?:https?:\/\/|ssh:\/\/git@)github\.com\/|git@github\.com:)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/,
      );
      const key = !source
        ? "unknown"
        : github
          ? `github:${github[1]!.toLowerCase()}/${github[2]!.toLowerCase()}`
          : `source:${source}`;
      const label = !source
        ? "Source unknown"
        : github
          ? `${github[1]} / ${github[2]}`
          : source;
      const current = sources.get(key) ?? { label, records: [] };
      current.records.push(record);
      sources.set(key, current);
    }
  return [...sources]
    .map(([key, value]) => ({
      key,
      label: value.label,
      entries: group(value.records, entries[0]?.usageMachines ?? []),
    }))
    .sort((a, b) =>
      a.key === "unknown"
        ? 1
        : b.key === "unknown"
          ? -1
          : a.label.localeCompare(b.label),
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
        "not-installed": "—",
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

/** A native session is scoped to its machine and harness. Multiple occurrences
 * and installation paths can contribute evidence but never multiply sessions. */
export function librarySessions(entry: LibraryEntry): Array<{
  machineId: string;
  machine: string;
  harness: string;
  sessionId: string;
  firstUsedAt: string;
  lastUsedAt: string;
  pathMatched: boolean;
}> {
  const grouped = new Map<
    string,
    {
      machineId: string;
      machine: string;
      harness: string;
      sessionId: string;
      firstUsedAt: string;
      lastUsedAt: string;
      pathMatched: boolean;
    }
  >();
  for (const record of entry.occurrences)
    for (const session of record.usageSessions ?? []) {
      const key = JSON.stringify([
        record.machine.id,
        session.harness,
        session.sessionId,
      ]);
      const current = grouped.get(key);
      if (current) {
        if (Date.parse(session.firstUsedAt) < Date.parse(current.firstUsedAt))
          current.firstUsedAt = session.firstUsedAt;
        if (Date.parse(session.lastUsedAt) > Date.parse(current.lastUsedAt))
          current.lastUsedAt = session.lastUsedAt;
        current.pathMatched ||= !!session.pathId;
      } else
        grouped.set(key, {
          machineId: record.machine.id,
          machine: record.machine.name,
          harness: session.harness,
          sessionId: session.sessionId,
          firstUsedAt: session.firstUsedAt,
          lastUsedAt: session.lastUsedAt,
          pathMatched: !!session.pathId,
        });
    }
  return [...grouped.values()].sort(
    (a, b) =>
      Date.parse(b.lastUsedAt) - Date.parse(a.lastUsedAt) ||
      a.machineId.localeCompare(b.machineId) ||
      a.harness.localeCompare(b.harness) ||
      a.sessionId.localeCompare(b.sessionId),
  );
}

/** Count disjoint session cohorts once, even when a session used several selected copies. */
export function librarySessionTotals(
  entry: LibraryEntry,
  machineId: string,
  harness: string,
) {
  const records = entry.occurrences.filter(
    (record) => record.machine.id === machineId,
  );
  const indexed = records.some((record) => record.sessionCohorts !== undefined);
  if (!indexed) return undefined;
  const paths = new Set(records.flatMap((record) => record.usagePathIds ?? []));
  const cohorts = new Map<
    string,
    NonNullable<(typeof records)[number]["sessionCohorts"]>[number]
  >();
  for (const record of records)
    for (const cohort of record.sessionCohorts ?? []) {
      if (cohort.harness !== harness) continue;
      const key = JSON.stringify([
        cohort.name,
        cohort.harness,
        [...cohort.pathIds].sort(),
        cohort.hasNameOnlyEvidence,
      ]);
      cohorts.set(key, cohort);
    }
  let verified = 0,
    named = 0;
  let lastUsedAt: string | undefined;
  for (const cohort of cohorts.values()) {
    const matched = cohort.pathIds.filter((path) => paths.has(path));
    if (matched.length) {
      verified += cohort.sessionCount;
      for (const path of matched) {
        const at = cohort.verifiedLastUsedAtByPath[path];
        if (at && (!lastUsedAt || Date.parse(at) > Date.parse(lastUsedAt)))
          lastUsedAt = at;
      }
    } else if (cohort.hasNameOnlyEvidence) named += cohort.sessionCount;
  }
  return { verified, named, lastUsedAt };
}
