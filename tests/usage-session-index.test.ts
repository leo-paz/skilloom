import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import type { SkillUsageEvent } from "../src/core/skill-usage.js";
import {
  isUsageSessionIndexDirty,
  readCachedUsageSessionIndex,
  readUsageSessionIndex,
  updateUsageSessionIndex,
} from "../src/core/usage-session-index.js";

const directories: string[] = [];
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "skilloom-session-index-"));
  directories.push(path);
  return path;
}
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const event = (
  id: string,
  overrides: Partial<SkillUsageEvent> = {},
): SkillUsageEvent => ({
  id: hash(id),
  name: "review",
  harness: "codex",
  evidence: "read",
  at: "2026-09-10T00:00:00Z",
  sessionId: hash("session"),
  sessionIdentityVersion: 1,
  pathId: hash("path"),
  ...overrides,
});
it("persists distinct sessions and installation membership without double counting name-only evidence", async () => {
  const dir = await directory();
  await updateUsageSessionIndex(dir, [
    event("one"),
    event("two", { pathId: hash("other"), at: "2026-09-11T00:00:00Z" }),
    event("three", {
      pathId: undefined,
      evidence: "invoke",
      at: "2026-09-12T00:00:00Z",
    }),
  ]);
  await updateUsageSessionIndex(dir, [
    event("one"),
    event("four", { sessionId: hash("second-session") }),
  ]);
  expect(await isUsageSessionIndexDirty(dir)).toBe(true);
  const result = await readUsageSessionIndex(dir, { recentLimit: 2 });
  expect(await isUsageSessionIndexDirty(dir)).toBe(false);
  expect(await readCachedUsageSessionIndex(dir)).toEqual(result);
  expect(await updateUsageSessionIndex(dir, [event("one")])).toBe(false);
  expect(await isUsageSessionIndexDirty(dir)).toBe(false);
  expect(result.cohorts.reduce((sum, c) => sum + c.sessionCount, 0)).toBe(2);
  const both = result.cohorts.find((c) => c.pathIds.length === 2)!;
  expect(both).toMatchObject({
    sessionCount: 1,
    hasNameOnlyEvidence: true,
    nameOnlyLastUsedAt: "2026-09-12T00:00:00Z",
    verifiedLastUsedAtByPath: {
      [hash("path")]: "2026-09-10T00:00:00Z",
      [hash("other")]: "2026-09-11T00:00:00Z",
    },
  });
  expect(result.recentSessions).toHaveLength(2);
  expect(await readUsageSessionIndex(dir, { recentLimit: 2 })).toEqual(result);
});
it("retracts conflicted verified session attribution even after prior indexing", async () => {
  const dir = await directory();
  await updateUsageSessionIndex(dir, [event("same")]);
  expect((await readUsageSessionIndex(dir)).cohorts[0]?.sessionCount).toBe(1);
  await updateUsageSessionIndex(dir, [
    event("same", { sessionId: hash("conflicting") }),
  ]);
  const conflicted = await readUsageSessionIndex(dir);
  expect(conflicted.cohorts).toEqual([]);
  expect(conflicted.unassignedEvidence).toEqual([
    { name: "review", harness: "codex", pathId: hash("path") },
  ]);
  await updateUsageSessionIndex(dir, [event("same")]);
  expect((await readUsageSessionIndex(dir)).cohorts).toEqual([]);
});
it("retains all sessions beyond display retention while recent rows stay bounded", async () => {
  const dir = await directory();
  for (let start = 0; start < 20020; start += 100) {
    await updateUsageSessionIndex(
      dir,
      Array.from({ length: Math.min(100, 20020 - start) }, (_, i) =>
        event(`event-${start + i}`, {
          sessionId: hash(`session-${start + i}`),
        }),
      ),
    );
  }
  const result = await readUsageSessionIndex(dir, { recentLimit: 5 });
  expect(result.cohorts).toHaveLength(1);
  expect(result.cohorts[0]?.sessionCount).toBe(20020);
  expect(result.recentSessions).toHaveLength(5);
}, 120000);

it("retains distinct evidence without native session attribution beyond recent row limits", async () => {
  const dir = await directory();
  await updateUsageSessionIndex(dir, [
    event("unknown-a", { sessionId: undefined }),
    event("unknown-b", { sessionId: undefined }),
    event("legacy", { sessionIdentityVersion: undefined }),
    event("name-only", { sessionId: undefined, pathId: undefined }),
    event("known", { name: "another" }),
  ]);
  const result = await readUsageSessionIndex(dir, { recentLimit: 0 });
  expect(result.recentSessions).toEqual([]);
  expect(result.cohorts.map((c) => c.name)).toEqual(["another"]);
  expect(result.unassignedEvidence).toEqual([
    { name: "review", harness: "codex" },
    { name: "review", harness: "codex", pathId: hash("path") },
  ]);
  expect((await readCachedUsageSessionIndex(dir))?.unassignedEvidence).toEqual(
    result.unassignedEvidence,
  );
});
