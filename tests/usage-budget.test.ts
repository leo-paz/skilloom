import { describe, expect, it } from "vitest";
import {
  type SkillUsageScan,
  skillUsageScanSchema,
} from "../src/core/skill-usage.js";
import {
  BACKFILL_BUDGET_MS,
  backfillBudgetMilliseconds,
  UsageBackfillBudget,
} from "../src/core/usage-budget.js";

describe("backfill time budget", () => {
  it("caps all batches together and keeps completed versus paused coverage distinct", () => {
    let now = 0;
    const budget = new UsageBackfillBudget(BACKFILL_BUDGET_MS, () => now);
    const scan: SkillUsageScan = {
      version: 2,
      usage: [],
      backfill: { complete: false, filesDiscovered: 200, filesPending: 48 },
      coverage: {
        status: "incomplete",
        filesDiscovered: 200,
        filesScanned: 152,
        bytesRead: 1000,
        limitsHit: ["backfill_pending"],
        observedAt: new Date().toISOString(),
      },
    };
    budget.start();
    now = 90_000;
    budget.start(); // A second batch must not receive another two minutes.
    expect(budget.expired).toBe(false);
    now = 120_000;
    budget.mark(scan);
    expect(budget.expired).toBe(true);
    expect(skillUsageScanSchema.parse(scan).backfill).toEqual({
      complete: false,
      filesDiscovered: 200,
      filesPending: 48,
      paused: "time_limit",
    });
    now += 30_000;
    budget.start(); // Recent-history refresh must not restart a paused backfill.
    expect(budget.expired).toBe(true);
    budget.reset(); // An explicit refresh gets a new bounded run.
    budget.start();
    budget.mark(scan);
    expect(scan.backfill?.paused).toBeUndefined();
    now += 120_000;
    scan.backfill!.complete = true;
    budget.mark(scan);
    expect(scan.backfill?.paused).toBeUndefined();
  });
  it("defaults to two minutes and accepts only bounded explicit overrides", () => {
    expect(backfillBudgetMilliseconds([])).toBe(120_000);
    expect(backfillBudgetMilliseconds(["--max-seconds", "180"])).toBe(180_000);
    for (const invalid of [
      undefined,
      "0",
      "-1",
      "181",
      "Infinity",
      "1.5",
      "--restart",
    ])
      expect(() =>
        backfillBudgetMilliseconds([
          "--max-seconds",
          ...(invalid ? [invalid] : []),
        ]),
      ).toThrow(/1 to 180/);
  });
});
