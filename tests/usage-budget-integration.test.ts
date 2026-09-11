import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { afterEach, expect, it, vi } from "vitest";
import { defaultRuntime } from "../src/cli/runtime.js";
import { usageCommand } from "../src/cli/usage.js";
import {
  type SkillUsageScan,
  scanSkillUsage,
} from "../src/core/skill-usage.js";
import { createDashboardBackend } from "../src/tui/dashboard.js";
import { inventoryFixture } from "./tui-fixture.js";

vi.mock("../src/core/skill-usage.js", async (original) => ({
  ...(await original<typeof import("../src/core/skill-usage.js")>()),
  scanSkillUsage: vi.fn(),
}));
afterEach(() => vi.restoreAllMocks());
const partial = (): SkillUsageScan => ({
  version: 2,
  usage: [],
  history: [],
  backfill: { complete: false, filesDiscovered: 200, filesPending: 48 },
  coverage: {
    status: "incomplete",
    filesDiscovered: 200,
    filesScanned: 48,
    bytesRead: 100,
    limitsHit: ["backfill_pending"],
    observedAt: new Date().toISOString(),
  },
});
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "usage-budget-"));
  const path = join(home, ".config/skilloom/inventory.json");
  await mkdir(join(home, ".config/skilloom"), { recursive: true });
  const inventory = inventoryFixture();
  inventory.skillUsage = partial();
  await writeFile(path, JSON.stringify(inventory));
  const output: string[] = [];
  return {
    home,
    path,
    inventory,
    output,
    runtime: {
      ...defaultRuntime(),
      env: { HOME: home },
      stdout: (text: string) => output.push(text),
    },
  };
}
it("CLI checkpoints and reports its cutoff without claiming complete, then resumes on another invocation", async () => {
  const f = await fixture();
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const scan = vi.mocked(scanSkillUsage).mockImplementation(async () => {
    now += 120_000;
    return partial();
  });
  try {
    expect(await usageCommand(["backfill"], f.runtime)).toBe(0);
    expect(scan).toHaveBeenCalledTimes(1);
    const result = JSON.parse(f.output[0]!);
    expect(result).toMatchObject({
      paused: true,
      timeBudgetSeconds: 120,
      backfill: { complete: false, paused: "time_limit" },
    });
    expect(
      JSON.parse(await readFile(f.path, "utf8")).skillUsage.backfill.paused,
    ).toBe("time_limit");
    expect(await usageCommand(["backfill"], f.runtime)).toBe(0);
    expect(scan).toHaveBeenCalledTimes(2);
    expect(scan.mock.calls[1]![0].restartBackfill).toBe(false);
  } finally {
    await rm(f.home, { recursive: true, force: true });
  }
});
it("dashboard stops historical work after two minutes while later refreshes only tail recent events", async () => {
  const f = await fixture();
  let now = 0;
  vi.spyOn(performance, "now").mockImplementation(() => now);
  const scan = vi
    .mocked(scanSkillUsage)
    .mockReset()
    .mockImplementation(async () => {
      now += 120_000;
      return partial();
    });
  const api = createDashboardBackend(f.runtime, async () => 0);
  try {
    const first = await api.collectHistory!(f.inventory);
    expect(first.skillUsage?.backfill?.paused).toBe("time_limit");
    await api.collectHistory!(first);
    await api.collectHistory!(first);
    expect(scan.mock.calls.map(([options]) => options.mode)).toEqual([
      "backfill",
      "tail",
      "tail",
    ]);
  } finally {
    await api.shutdown();
    await rm(f.home, { recursive: true, force: true });
  }
});
