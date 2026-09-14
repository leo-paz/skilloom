import { createHash, randomUUID } from "node:crypto";
import { mkdir, opendir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import type { SkillHarness, SkillUsageEvent } from "./skill-usage.js";
import {
  atomicUsageJson,
  mergeUsageEvent,
  withUsageLock,
} from "./usage-journal.js";
import type { SkillUsageSession } from "./usage-sessions.js";

export interface SessionCohortSummary {
  name: string;
  harness: SkillHarness;
  pathIds: string[];
  hasNameOnlyEvidence: boolean;
  sessionCount: number;
  verifiedLastUsedAtByPath: Record<string, string>;
  nameOnlyLastUsedAt?: string | undefined;
  firstUsedAt: string;
  lastUsedAt: string;
}
export type SessionCohort = SessionCohortSummary;
export interface UnassignedSessionEvidence {
  name: string;
  harness: SkillHarness;
  pathId?: string | undefined;
}
export interface UsageSessionIndexSnapshot {
  version: 1;
  cohorts: SessionCohortSummary[];
  recentSessions: SkillUsageSession[];
  unassignedEvidence?: UnassignedSessionEvidence[] | undefined;
}
interface SessionSkill {
  name: string;
  harness: SkillHarness;
  sessionId: string;
  paths: Record<
    string,
    { firstUsedAt: string; lastUsedAt: string; eventCount: number }
  >;
}
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export const usageSessionIndexSummaryPath = (directory: string) =>
  join(indexRoot(directory), "summary.json");

/** Last completed reduction; a running scan can retain these totals until its
 * new atomic snapshot is ready, without blocking the TUI on historical I/O. */
export async function readCachedUsageSessionIndex(
  directory: string,
): Promise<UsageSessionIndexSnapshot | undefined> {
  const value = await readJson<UsageSessionIndexSnapshot>(
    usageSessionIndexSummaryPath(directory),
  );
  if (
    !value ||
    value.version !== 1 ||
    !Array.isArray(value.cohorts) ||
    !Array.isArray(value.recentSessions)
  )
    return undefined;
  if (
    value.cohorts.some(
      (c) =>
        !c ||
        typeof c !== "object" ||
        typeof c.name !== "string" ||
        !["codex", "claude", "pi"].includes(c.harness) ||
        !Array.isArray(c.pathIds) ||
        c.pathIds.some((id) => !/^[a-f0-9]{64}$/.test(id)) ||
        !Number.isSafeInteger(c.sessionCount) ||
        c.sessionCount < 1 ||
        !Number.isFinite(Date.parse(c.firstUsedAt)) ||
        !Number.isFinite(Date.parse(c.lastUsedAt)) ||
        typeof c.hasNameOnlyEvidence !== "boolean" ||
        !c.verifiedLastUsedAtByPath ||
        Object.entries(c.verifiedLastUsedAtByPath).some(
          ([id, at]) =>
            !/^[a-f0-9]{64}$/.test(id) || !Number.isFinite(Date.parse(at)),
        ),
    )
  )
    return undefined;
  if (
    value.recentSessions.length > 1000 ||
    value.recentSessions.some(
      (s) =>
        !s ||
        typeof s.name !== "string" ||
        !["codex", "claude", "pi"].includes(s.harness) ||
        !/^[a-f0-9]{64}$/.test(s.sessionId) ||
        (s.pathId !== undefined && !/^[a-f0-9]{64}$/.test(s.pathId)) ||
        !Number.isFinite(Date.parse(s.firstUsedAt)) ||
        !Number.isFinite(Date.parse(s.lastUsedAt)) ||
        !Number.isSafeInteger(s.eventCount) ||
        s.eventCount < 1,
    )
  )
    return undefined;
  if (
    value.unassignedEvidence !== undefined &&
    (!Array.isArray(value.unassignedEvidence) ||
      value.unassignedEvidence.some(
        (e) =>
          !e ||
          typeof e.name !== "string" ||
          !["codex", "claude", "pi"].includes(e.harness) ||
          (e.pathId !== undefined && !/^[a-f0-9]{64}$/.test(e.pathId)),
      ))
  )
    return undefined;
  return value;
}

export async function isUsageSessionIndexDirty(
  directory: string,
): Promise<boolean> {
  return !!(await readJson(join(indexRoot(directory), "dirty.json")));
}
const indexRoot = (directory: string) => join(directory, "session-index-v1");
const recordPath = (root: string, id: string) =>
  join(root, id.slice(0, 2), `${id}.json`);
async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
async function* records(root: string): AsyncGenerator<string> {
  for (let shard = 0; shard < 256; shard++) {
    let yielded = false;
    try {
      // Bun can defer ENOENT until directory iteration; Node rejects opendir.
      const dir = await opendir(
        join(root, shard.toString(16).padStart(2, "0")),
      );
      for await (const entry of dir) {
        if (/^[a-f0-9]{64}\.json$/.test(entry.name)) {
          if (!entry.isFile()) throw new Error("Invalid usage index record");
          yielded = true;
          yield join(dir.path, entry.name);
        }
      }
    } catch (error) {
      if (yielded || (error as NodeJS.ErrnoException).code !== "ENOENT")
        throw error;
    }
  }
}
/** Keeps normalized evidence, never transcripts. Event identities must survive the
 * display-history cap: a later conflicting attribution can retract a session. */
export async function updateUsageSessionIndex(
  directory: string,
  events: readonly SkillUsageEvent[],
): Promise<boolean> {
  if (!events.length) return false;
  const root = indexRoot(directory);
  return withUsageLock(
    join(root, "index.lock"),
    async () => {
      let changed = false;
      for (const event of events) {
        if (!/^[a-f0-9]{64}$/.test(event.id))
          throw new Error("Invalid usage event identity");
        const path = recordPath(join(root, "events"), event.id);
        const prior = await readJson<SkillUsageEvent>(path);
        const merged = mergeUsageEvent(prior, event);
        if (JSON.stringify(prior) !== JSON.stringify(merged)) {
          if (!changed)
            await atomicUsageJson(join(root, "dirty.json"), { dirty: true });
          changed = true;
          await atomicUsageJson(path, merged);
        }
      }
      return changed;
    },
    undefined,
    120000,
  );
}
/** Streams disk records twice. Memory contains one session/skill's installation
 * set and the output cohorts, never all event IDs or native session IDs. Cohorts
 * describe identical installation membership, allowing exact union counts for
 * arbitrary Library source/path filters without adding overlapping counts. */
export async function readUsageSessionIndex(
  directory: string,
  options: { recentLimit?: number; signal?: AbortSignal } = {},
): Promise<UsageSessionIndexSnapshot> {
  const root = indexRoot(directory);
  const recentLimit = Math.max(0, Math.min(1000, options.recentLimit ?? 100));
  return withUsageLock(
    join(root, "index.lock"),
    async () => {
      const scratch = join(root, `reduce-${randomUUID()}`);
      await mkdir(scratch, { recursive: true, mode: 0o700 });
      try {
        const unassignedEvidence = new Map<string, UnassignedSessionEvidence>();
        for await (const path of records(join(root, "events"))) {
          options.signal?.throwIfAborted();
          const event = await readJson<SkillUsageEvent>(path);
          if (!event) continue;
          if (
            !event.sessionId ||
            !/^[a-f0-9]{64}$/.test(event.sessionId) ||
            (event.harness === "codex" && event.sessionIdentityVersion !== 1)
          ) {
            const key = JSON.stringify([
              event.name,
              event.harness,
              event.pathId ?? null,
            ]);
            unassignedEvidence.set(key, {
              name: event.name,
              harness: event.harness,
              ...(event.pathId ? { pathId: event.pathId } : {}),
            });
            continue;
          }
          const key = digest(
            JSON.stringify([event.name, event.harness, event.sessionId]),
          );
          const target = recordPath(scratch, key);
          const current = (await readJson<SessionSkill>(target)) ?? {
            name: event.name,
            harness: event.harness,
            sessionId: event.sessionId,
            paths: {},
          };
          const pathKey = event.pathId ?? "name-only";
          const times = current.paths[pathKey];
          current.paths[pathKey] = {
            eventCount: (times?.eventCount ?? 0) + 1,
            firstUsedAt:
              times && Date.parse(times.firstUsedAt) < Date.parse(event.at)
                ? times.firstUsedAt
                : event.at,
            lastUsedAt:
              times && Date.parse(times.lastUsedAt) > Date.parse(event.at)
                ? times.lastUsedAt
                : event.at,
          };
          await atomicUsageJson(target, current);
        }
        const cohorts = new Map<string, SessionCohortSummary>();
        const recentSessions: SkillUsageSession[] = [];
        for await (const path of records(scratch)) {
          options.signal?.throwIfAborted();
          const session = await readJson<SessionSkill>(path);
          if (!session) continue;
          const pathIds = Object.keys(session.paths)
            .filter((id) => id !== "name-only")
            .sort();
          const hasNameOnlyEvidence = !!session.paths["name-only"];
          const values = Object.values(session.paths);
          const firstUsedAt = values.reduce(
            (a, b) =>
              Date.parse(a) < Date.parse(b.firstUsedAt) ? a : b.firstUsedAt,
            values[0]!.firstUsedAt,
          );
          const lastUsedAt = values.reduce(
            (a, b) =>
              Date.parse(a) > Date.parse(b.lastUsedAt) ? a : b.lastUsedAt,
            values[0]!.lastUsedAt,
          );
          const key = JSON.stringify([
            session.name,
            session.harness,
            pathIds,
            hasNameOnlyEvidence,
          ]);
          const prior = cohorts.get(key);
          if (prior) {
            prior.sessionCount++;
            for (const [pathId, times] of Object.entries(session.paths)) {
              if (pathId === "name-only") {
                if (
                  !prior.nameOnlyLastUsedAt ||
                  Date.parse(times.lastUsedAt) >
                    Date.parse(prior.nameOnlyLastUsedAt)
                )
                  prior.nameOnlyLastUsedAt = times.lastUsedAt;
              } else if (
                !prior.verifiedLastUsedAtByPath[pathId] ||
                Date.parse(times.lastUsedAt) >
                  Date.parse(prior.verifiedLastUsedAtByPath[pathId]!)
              )
                prior.verifiedLastUsedAtByPath[pathId] = times.lastUsedAt;
            }
            if (Date.parse(firstUsedAt) < Date.parse(prior.firstUsedAt))
              prior.firstUsedAt = firstUsedAt;
            if (Date.parse(lastUsedAt) > Date.parse(prior.lastUsedAt))
              prior.lastUsedAt = lastUsedAt;
          } else
            cohorts.set(key, {
              name: session.name,
              harness: session.harness,
              pathIds,
              hasNameOnlyEvidence,
              sessionCount: 1,
              verifiedLastUsedAtByPath: Object.fromEntries(
                pathIds.map((id) => [id, session.paths[id]!.lastUsedAt]),
              ),
              ...(session.paths["name-only"]
                ? { nameOnlyLastUsedAt: session.paths["name-only"].lastUsedAt }
                : {}),
              firstUsedAt,
              lastUsedAt,
            });
          for (const [pathId, times] of Object.entries(session.paths)) {
            recentSessions.push({
              name: session.name,
              harness: session.harness,
              sessionId: session.sessionId,
              ...(pathId === "name-only" ? {} : { pathId }),
              ...times,
            });
          }
          recentSessions.sort(
            (a, b) =>
              Date.parse(b.lastUsedAt) - Date.parse(a.lastUsedAt) ||
              a.sessionId.localeCompare(b.sessionId),
          );
          recentSessions.length = Math.min(recentLimit, recentSessions.length);
        }
        const snapshot: UsageSessionIndexSnapshot = {
          version: 1,
          cohorts: [...cohorts.values()].sort(
            (a, b) =>
              a.name.localeCompare(b.name) ||
              a.harness.localeCompare(b.harness) ||
              JSON.stringify(a.pathIds).localeCompare(
                JSON.stringify(b.pathIds),
              ),
          ),
          recentSessions,
          unassignedEvidence: [...unassignedEvidence.values()].sort(
            (a, b) =>
              a.name.localeCompare(b.name) ||
              a.harness.localeCompare(b.harness) ||
              (a.pathId ?? "").localeCompare(b.pathId ?? ""),
          ),
        };
        await atomicUsageJson(
          usageSessionIndexSummaryPath(directory),
          snapshot,
        );
        await rm(join(root, "dirty.json"), { force: true });
        return snapshot;
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    },
    undefined,
    120000,
  );
}
