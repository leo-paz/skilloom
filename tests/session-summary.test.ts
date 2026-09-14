import { expect, it } from "vitest";
import {
  buildLibrary,
  filterLibrary,
  librarySessionTotals,
} from "../src/tui/catalog.js";
import { sessionUsageSummary } from "../src/tui/session-summary.js";
import { inventoryFixture } from "./tui-fixture.js";

const fixture = () => {
  const inventory = inventoryFixture();
  inventory.skillUsage!.harnessCoverage = [
    {
      harness: "codex",
      status: "partial",
      filesScanned: 500,
      pendingCalls: 0,
      limitations: ["history_window"],
    },
  ];
  return inventory;
};
it("presents selected-skill sessions once, not machine-wide scan counts", () => {
  const inventory = fixture();
  const entry = buildLibrary(inventory).find((e) => e.name === "code-review")!;
  entry.occurrences.push(entry.occurrences[0]!);
  const summary = sessionUsageSummary(entry);
  expect(summary.rows[0]!.cells.map((c) => c.label)).toEqual([
    "1 session",
    "0 recorded",
    "0 recorded",
  ]);
  expect(summary.notes.some((n) => n.message.includes("Earlier history"))).toBe(
    true,
  );
  expect(JSON.stringify(summary)).not.toMatch(/Partial scan|Logs scanned|500/);
});
it("distinguishes missing session identity, no match, uncollected data and absent installation", () => {
  const inventory = fixture();
  inventory.skillUsage!.sessions = [];
  let summary = sessionUsageSummary(
    buildLibrary(inventory).find((e) => e.name === "code-review")!,
  );
  expect(summary.rows[0]!.cells[0]!.label).toBe("Unknown");
  expect(
    summary.notes.some((n) =>
      n.message.includes("no verified session identity"),
    ),
  ).toBe(true);
  delete inventory.skillUsage!.sessions;
  summary = sessionUsageSummary(
    buildLibrary(inventory).find((e) => e.name === "code-review")!,
  );
  expect(summary.rows[0]!.cells[0]!.label).toBe("Not checked");
  expect(summary.rows[1]!.cells[0]!.label).toBe("Not checked");
  inventory.remoteObservations![0]!.skillUsage = {
    ...inventory.skillUsage!,
    sessions: [],
  };
  summary = sessionUsageSummary(
    buildLibrary(inventory).find((e) => e.name === "code-review")!,
  );
  expect(summary.rows[1]!.cells[0]!.label).toBe("No install");
});
it("keeps name-only evidence separate and explains paused history instead of a generic status", () => {
  const inventory = fixture();
  const session = inventory.skillUsage!.sessions![0]!;
  inventory.skillUsage!.sessions = [{ ...session, pathId: undefined }];
  inventory.skillUsage!.usage = [
    {
      ...inventory.skillUsage!.usage[0]!,
      pathId: undefined,
      evidence: "invoke",
    },
  ];
  inventory.skillUsage!.backfill = {
    complete: false,
    filesDiscovered: 500,
    filesPending: 20,
    paused: "time_limit",
  };
  const summary = sessionUsageSummary(
    buildLibrary(inventory).find((e) => e.name === "code-review")!,
  );
  expect(summary.rows[0]!.cells[0]!.label).toBe("1 by name");
  expect(
    summary.notes.some((n) => n.message.includes("installation is unknown")),
  ).toBe(true);
  expect(
    summary.notes.some((n) => n.message.includes("history was paused")),
  ).toBe(true);
});

it("counts durable distinct sessions once across paths and survives recent-history truncation", () => {
  const inventory = fixture();
  const a = "a".repeat(64),
    b = "b".repeat(64);
  inventory.projects = [];
  inventory.remoteObservations = [];
  inventory.globalSkills[0]!.source = "one/skills";
  inventory.globalSkills.push({
    ...inventory.globalSkills[0]!,
    source: "two/skills",
    usagePathIds: [b],
  });
  inventory.skillUsage!.sessions = [];
  inventory.skillUsage!.sessionsTruncated = true;
  inventory.skillUsage!.sessionCohorts = [
    {
      name: "code-review",
      harness: "codex",
      pathIds: [a, b],
      hasNameOnlyEvidence: true,
      sessionCount: 12000,
      firstUsedAt: "2026-01-01T00:00:00Z",
      lastUsedAt: "2026-09-10T00:00:00Z",
      verifiedLastUsedAtByPath: {
        [a]: "2026-09-08T00:00:00Z",
        [b]: "2026-09-09T00:00:00Z",
      },
    },
  ];
  const entry = buildLibrary(inventory)[0]!;
  expect(librarySessionTotals(entry, "local", "codex")).toEqual({
    verified: 12000,
    named: 0,
    lastUsedAt: "2026-09-09T00:00:00Z",
  });
  const filtered = filterLibrary([entry], {
    query: "one/skills",
    machine: "local",
    scope: "all",
    ownership: "all",
  })[0]!;
  expect(librarySessionTotals(filtered, "local", "codex")).toEqual({
    verified: 12000,
    named: 0,
    lastUsedAt: "2026-09-08T00:00:00Z",
  });
  expect(
    sessionUsageSummary(entry).rows.find((row) => row.machine === "Workstation")
      ?.cells[0]?.label,
  ).toBe("12000 sessions");
});

it("preserves unknown identities outside the recent window with a durable index", () => {
  const inventory = inventoryFixture();
  inventory.skillUsage!.sessions = [];
  inventory.skillUsage!.history = [];
  inventory.skillUsage!.usage = [];
  inventory.skillUsage!.sessionCohorts = [];
  inventory.skillUsage!.unassignedSessionEvidence = [
    {
      name: "code-review",
      harness: "codex",
      pathId: "a".repeat(64),
    },
  ];
  const summary = sessionUsageSummary(
    buildLibrary(inventory).find((entry) => entry.name === "code-review")!,
  );
  expect(summary.rows[0]!.cells[0]!.label).toBe("Unknown");
  expect(
    summary.notes.some((note) =>
      note.message.includes("no verified session identity"),
    ),
  ).toBe(true);
});
it("retains unresolved name-only invocation when filtering away its session's verified path", () => {
  const inventory = inventoryFixture();
  inventory.projects = [];
  inventory.remoteObservations = [];
  inventory.skillUsage!.sessionCohorts = [
    {
      name: "code-review",
      harness: "codex",
      pathIds: ["b".repeat(64)],
      hasNameOnlyEvidence: true,
      sessionCount: 1,
      firstUsedAt: "2026-01-01T00:00:00Z",
      lastUsedAt: "2026-09-10T00:00:00Z",
      verifiedLastUsedAtByPath: { ["b".repeat(64)]: "2026-09-10T00:00:00Z" },
    },
  ];
  const entry = buildLibrary(inventory).find(
    (entry) => entry.name === "code-review",
  )!;
  expect(librarySessionTotals(entry, "local", "codex")).toEqual({
    verified: 0,
    named: 1,
    lastUsedAt: undefined,
  });
});
