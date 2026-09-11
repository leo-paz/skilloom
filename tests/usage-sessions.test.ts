import { expect, it } from "vitest";
import type { SkillUsageEvent } from "../src/core/skill-usage.js";
import { groupUsageSessions } from "../src/core/usage-sessions.js";

const event = (overrides: Partial<SkillUsageEvent> = {}): SkillUsageEvent => ({
  id: "a".repeat(64),
  name: "review",
  harness: "claude",
  evidence: "read",
  sessionId: "b".repeat(64),
  pathId: "c".repeat(64),
  at: "2026-09-10T00:00:00Z",
  ...overrides,
});
it("groups repeated reads and loads in one native session without merging installations or agents", () => {
  const first = event();
  const sessions = groupUsageSessions([
    first,
    first,
    event({ id: "d".repeat(64), evidence: "load", at: "2026-09-10T01:00:00Z" }),
    event({ id: "e".repeat(64), pathId: "f".repeat(64) }),
    event({ id: "f".repeat(64), harness: "pi" }),
  ]);
  expect(sessions).toHaveLength(3);
  expect(
    sessions.find((s) => s.harness === "claude" && s.pathId === first.pathId),
  ).toMatchObject({
    eventCount: 2,
    firstUsedAt: first.at,
    lastUsedAt: "2026-09-10T01:00:00Z",
  });
});
it("does not invent sessions for missing or legacy ambiguous identities; name-only remains separate", () => {
  const sessions = groupUsageSessions([
    event({ sessionId: undefined }),
    event({ id: "d".repeat(64), harness: "codex" }),
    event({ id: "e".repeat(64), harness: "codex", sessionIdentityVersion: 1 }),
    event({ id: "f".repeat(64), pathId: undefined, evidence: "invoke" }),
  ]);
  expect(sessions).toHaveLength(2);
  expect(sessions.find((s) => s.harness === "codex")?.eventCount).toBe(1);
  expect(sessions.find((s) => s.harness === "claude")?.pathId).toBeUndefined();
});
it("summarizes more than the 1000-event display window", () => {
  const sessions = groupUsageSessions(
    Array.from({ length: 1100 }, (_, i) =>
      event({
        id: i.toString(16).padStart(64, "0"),
        sessionId: i.toString(16).padStart(64, "0"),
      }),
    ),
  );
  expect(sessions).toHaveLength(1100);
});

it("keeps the same session ID on different machines distinct and respects machine filters", async () => {
  const { inventoryFixture } = await import("./tui-fixture.js");
  const { buildLibrary, filterLibrary, librarySessions } = await import(
    "../src/tui/catalog.js"
  );
  const inventory = inventoryFixture();
  const session = {
    name: "code-review",
    harness: "claude" as const,
    sessionId: "b".repeat(64),
    pathId: "a".repeat(64),
    firstUsedAt: "2026-09-10T00:00:00Z",
    lastUsedAt: "2026-09-10T01:00:00Z",
    eventCount: 5,
  };
  inventory.skillUsage!.sessions = [session];
  const skill = structuredClone(inventory.globalSkills[0]!);
  inventory.remoteObservations![0]!.globalSkills = [skill];
  inventory.remoteObservations![0]!.skillUsage = {
    ...structuredClone(inventory.skillUsage!),
    sessions: [session],
  };
  const entry = buildLibrary(inventory).find((e) => e.name === "code-review")!;
  expect(librarySessions(entry)).toHaveLength(2);
  entry.occurrences.push(entry.occurrences[0]!);
  expect(librarySessions(entry)).toHaveLength(2);
  const filtered = filterLibrary([entry], {
    query: "",
    machine: inventory.machine.id,
    scope: "all",
    ownership: "all",
  });
  expect(librarySessions(filtered[0]!)).toHaveLength(1);
});

it("does not let discovery order assign a conflicting event to an arbitrary session", () => {
  const a = event({ harness: "codex", sessionIdentityVersion: 1 });
  const b = { ...a, sessionId: "e".repeat(64) };
  expect(groupUsageSessions([a, b])).toEqual([]);
  expect(groupUsageSessions([b, a])).toEqual([]);
});
