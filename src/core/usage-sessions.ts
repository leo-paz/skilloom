import type { SkillHarness, SkillUsageEvent } from "./skill-usage.js";
import { mergeUsageEvent } from "./usage-journal.js";

export interface SkillUsageSession {
  name: string;
  harness: SkillHarness;
  sessionId: string;
  pathId?: string | undefined;
  firstUsedAt: string;
  lastUsedAt: string;
  eventCount: number;
}

/** Group verified evidence within a native session, preserving installation boundaries.
 * Missing/legacy ambiguous identities are never replaced by a file name or timestamp. */
export function groupUsageSessions(
  events: SkillUsageEvent[],
): SkillUsageSession[] {
  const grouped = new Map<string, SkillUsageSession>();
  const unique = new Map<string, SkillUsageEvent>();
  for (const event of events) {
    unique.set(event.id, mergeUsageEvent(unique.get(event.id), event));
  }
  for (const event of unique.values()) {
    if (
      !event.sessionId ||
      !/^[a-f0-9]{64}$/.test(event.sessionId) ||
      (event.harness === "codex" && event.sessionIdentityVersion !== 1)
    )
      continue;
    const key = JSON.stringify([
      event.name,
      event.harness,
      event.sessionId,
      event.pathId ?? null,
    ]);
    const current = grouped.get(key);
    if (current) {
      current.eventCount++;
      if (Date.parse(event.at) < Date.parse(current.firstUsedAt))
        current.firstUsedAt = event.at;
      if (Date.parse(event.at) > Date.parse(current.lastUsedAt))
        current.lastUsedAt = event.at;
    } else
      grouped.set(key, {
        name: event.name,
        harness: event.harness,
        sessionId: event.sessionId,
        ...(event.pathId ? { pathId: event.pathId } : {}),
        firstUsedAt: event.at,
        lastUsedAt: event.at,
        eventCount: 1,
      });
  }
  return [...grouped.values()].sort(
    (a, b) =>
      Date.parse(b.lastUsedAt) - Date.parse(a.lastUsedAt) ||
      a.sessionId.localeCompare(b.sessionId),
  );
}
