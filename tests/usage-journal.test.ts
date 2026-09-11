import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  appendUsageEvents,
  readUsageJournal,
  recordHookUsage,
  saveUsageManifest,
  usageEventId,
  withUsageLock,
} from "../src/core/usage-journal.js";

it("serializes concurrent writers, deduplicates hook/trace identity and never saves raw hook bodies", async () => {
  const dir = await mkdtemp(join(tmpdir(), "usage-journal-"));
  const skill = join(dir, "review/SKILL.md");
  await mkdir(join(dir, "review"));
  await writeFile(skill, "private body");
  await saveUsageManifest(dir, [{ name: "review", paths: [skill] }]);
  const input = {
    harness: "claude" as const,
    sessionId: "session",
    callId: "call",
    at: "2026-09-10T01:00:00Z",
    evidence: "read" as const,
    path: skill,
  };
  await Promise.all(
    Array.from({ length: 8 }, () => recordHookUsage(dir, input)),
  );
  const result = await readUsageJournal(dir);
  expect(result.events).toHaveLength(1);
  expect(result.events[0]?.id).toBe(
    usageEventId(
      "claude",
      "session",
      "call",
      "review",
      result.events[0]?.pathId,
      "read",
    ),
  );
  expect(JSON.stringify(result.events)).not.toContain("private body");
  expect(JSON.stringify(result.events)).not.toContain(skill);
  await appendUsageEvents(dir, result.events);
  expect((await readUsageJournal(dir)).events).toEqual(result.events);
});
it("does not steal an active collector lock", async () => {
  const dir = await mkdtemp(join(tmpdir(), "usage-lock-"));
  await withUsageLock(join(dir, "lock"), async () => {
    await expect(
      withUsageLock(join(dir, "lock"), async () => {}, undefined, 30),
    ).rejects.toThrow("busy");
  });
  await writeFile(
    join(dir, "lock"),
    JSON.stringify({ pid: 2147483647, token: "dead" }),
  );
  await withUsageLock(join(dir, "lock"), async () =>
    writeFile(join(dir, "ok"), "ok"),
  );
  expect(await readFile(join(dir, "ok"), "utf8")).toBe("ok");
});
it("keeps a torn tail visible while preserving the next appended event", async () => {
  const dir = await mkdtemp(join(tmpdir(), "usage-torn-journal-"));
  const path = join(
    dir,
    `events-${new Date().toISOString().slice(0, 10)}.jsonl`,
  );
  await writeFile(path, '{"version":1,"id":"interrupted');
  expect(await readUsageJournal(dir)).toEqual({ events: [], truncated: true });
  const event = {
    id: usageEventId(
      "claude",
      "session",
      "after-crash",
      "review",
      undefined,
      "invoke",
    ),
    name: "review",
    harness: "claude" as const,
    evidence: "invoke" as const,
    at: "2026-09-10T01:00:00Z",
  };
  await appendUsageEvents(dir, [event]);
  const result = await readUsageJournal(dir);
  expect(result).toEqual({ events: [event], truncated: true });
  expect(await readFile(path, "utf8")).toContain('interrupted\n{"version":1');
});
