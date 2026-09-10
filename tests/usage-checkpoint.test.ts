import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { scanSkillUsage } from "../src/core/skill-usage.js";

it("finds chronological coverage without sorting and invalidates a replaced checkpoint", async () => {
  const home = await mkdtemp(join(tmpdir(), "usage-checkpoint-"));
  try {
    const options = {
      env: { HOME: home },
      cachePath: join(home, "cache.json"),
      knownSkills: [],
      mode: "backfill" as const,
    };
    await scanSkillUsage(options);
    const path = `${options.cachePath}.backfill`;
    const cache = JSON.parse(await readFile(path, "utf8"));
    const times = [
      "2026-09-09T12:00:00-07:00",
      "2026-09-09T18:00:00Z",
      "2026-09-09T13:30:00-07:00",
    ];
    for (const [i, at] of times.entries())
      cache.files[createHash("sha256").update(String(i)).digest("hex")] = {
        identity: `fixture:${i}`,
        offset: 10,
        mtimeMs: 1,
        sessionId: String(i),
        harness: "claude",
        cwd: "/",
        pending: [],
        oldestAt: at,
        newestAt: at,
      };
    await writeFile(path, JSON.stringify(cache));
    for (let pass = 0; pass < 2; pass++) {
      const scan = await scanSkillUsage(options);
      expect(
        scan.harnessCoverage?.find((item) => item.harness === "claude"),
      ).toMatchObject({
        filesScanned: 3,
        oldestAt: times[1],
        newestAt: times[2],
      });
    }
    // Another collector replaces the checkpoint between warm passes.
    cache.files = {};
    await writeFile(path, JSON.stringify(cache));
    const replacement = await scanSkillUsage(options);
    expect(
      replacement.harnessCoverage?.find((item) => item.harness === "claude")
        ?.filesScanned,
    ).toBe(0);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

it("keeps the committed checkpoint when installation verification runs out of time", async () => {
  const home = await mkdtemp(join(tmpdir(), "usage-checkpoint-time-"));
  try {
    const options = {
      env: { HOME: home },
      cachePath: join(home, "cache.json"),
      knownSkills: [],
      mode: "backfill" as const,
    };
    await scanSkillUsage(options);
    const path = `${options.cachePath}.backfill`;
    const before = await readFile(path, "utf8");
    let reads = 0;
    const clock = vi
      .spyOn(Date, "now")
      .mockImplementation(() => (reads++ < 2 ? 0 : 2000));
    try {
      await expect(
        scanSkillUsage({
          ...options,
          knownSkills: [{ name: "review", paths: [join(home, "SKILL.md")] }],
        }),
      ).rejects.toThrow("installation verification interrupted");
    } finally {
      clock.mockRestore();
    }
    expect(await readFile(path, "utf8")).toBe(before);
    expect((await scanSkillUsage(options)).backfill?.complete).toBe(true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
