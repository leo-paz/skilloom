import { expect, it } from "vitest";
import { buildLibrary } from "../src/tui/catalog.js";
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
    summary.notes.some((n) => n.message.includes("two-minute limit")),
  ).toBe(true);
});
