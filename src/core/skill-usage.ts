import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  opendir,
  readFile,
  realpath,
  rename,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import {
  codexRecordCreatedAt,
  extractCodexSessionIdentity,
  extractCodexSkillEvents,
} from "./codex-skill-events.js";
import {
  BACKFILL_BATCH_SIZE,
  type BackfillState,
  discoverBackfill,
  newBackfillState,
} from "./usage-backfill.js";
import {
  appendUsageEvents,
  atomicUsageJson,
  mergeUsageEvent,
  readUsageJournal,
  saveUsageManifest,
  usageDirectory,
  usageEventId,
  withUsageLock,
} from "./usage-journal.js";
import {
  groupUsageSessions,
  type SkillUsageSession,
} from "./usage-sessions.js";

export type SkillHarness = "codex" | "claude" | "pi";
export interface SkillUsage {
  name: string;
  harness: SkillHarness;
  evidence: "invoke" | "read" | "load";
  count: number;
  lastUsedAt: string;
  pathId?: string | undefined;
}
export interface SkillUsageEvent {
  id: string;
  name: string;
  harness: SkillHarness;
  evidence: "invoke" | "read" | "load";
  at: string;
  pathId?: string | undefined;
  /** Opaque session identity, never transcript text or a local path. */
  sessionId?: string | undefined;
  /** Root session attribution verified by the current adapter; absent on legacy Codex events. */
  sessionIdentityVersion?: 1 | undefined;
}
export interface HarnessUsageCoverage {
  harness: SkillHarness;
  status: "unscanned" | "partial" | "scanned" | "absent";
  filesScanned: number;
  pendingCalls: number;
  oldestAt?: string | undefined;
  newestAt?: string | undefined;
  limitations: string[];
}
export interface SkillUsageScan {
  version: 2;
  usage: SkillUsage[];
  history?: SkillUsageEvent[] | undefined;
  historyTruncated?: boolean | undefined;
  sessions?: SkillUsageSession[] | undefined;
  sessionsTruncated?: boolean | undefined;
  harnessCoverage?: HarnessUsageCoverage[] | undefined;
  backfill?:
    | {
        complete: boolean;
        filesDiscovered: number;
        filesPending: number;
        paused?: "time_limit" | undefined;
      }
    | undefined;
  coverage: {
    status: "complete" | "incomplete";
    filesDiscovered: number;
    filesScanned: number;
    bytesRead: number;
    limitsHit: string[];
    observedAt: string;
  };
}
export const skillUsageScanSchema = z.object({
  version: z.literal(2),
  usage: z.array(
    z.object({
      name: z.string(),
      harness: z.enum(["codex", "claude", "pi"]),
      evidence: z.enum(["invoke", "read", "load"]),
      count: z.number().int().nonnegative(),
      lastUsedAt: z.string(),
      pathId: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
    }),
  ),
  history: z
    .array(
      z.object({
        id: z.string().regex(/^[a-f0-9]{64}$/),
        name: z.string().max(256),
        harness: z.enum(["codex", "claude", "pi"]),
        evidence: z.enum(["invoke", "read", "load"]),
        at: z.string().datetime({ offset: true }),
        pathId: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
        sessionIdentityVersion: z.literal(1).optional(),
        sessionId: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
      }),
    )
    .max(1000)
    .optional(),
  historyTruncated: z.boolean().optional(),
  sessions: z
    .array(
      z.object({
        name: z.string().max(256),
        harness: z.enum(["codex", "claude", "pi"]),
        sessionId: z.string().regex(/^[a-f0-9]{64}$/),
        pathId: z
          .string()
          .regex(/^[a-f0-9]{64}$/)
          .optional(),
        firstUsedAt: z.string().datetime({ offset: true }),
        lastUsedAt: z.string().datetime({ offset: true }),
        eventCount: z.number().int().positive(),
      }),
    )
    .max(10000)
    .optional(),
  sessionsTruncated: z.boolean().optional(),
  harnessCoverage: z
    .array(
      z.object({
        harness: z.enum(["codex", "claude", "pi"]),
        status: z.enum(["unscanned", "partial", "scanned", "absent"]),
        filesScanned: z.number().int().nonnegative(),
        pendingCalls: z.number().int().nonnegative(),
        oldestAt: z.string().optional(),
        newestAt: z.string().optional(),
        limitations: z.array(z.string()),
      }),
    )
    .optional(),
  backfill: z
    .object({
      complete: z.boolean(),
      filesDiscovered: z.number().int().nonnegative(),
      filesPending: z.number().int().nonnegative(),
      paused: z.literal("time_limit").optional(),
    })
    .optional(),
  coverage: z.object({
    status: z.enum(["complete", "incomplete"]),
    filesDiscovered: z.number().int().nonnegative(),
    filesScanned: z.number().int().nonnegative(),
    bytesRead: z.number().int().nonnegative(),
    limitsHit: z.array(z.string()),
    observedAt: z.string(),
  }),
});
interface Pending {
  groupSessionId?: string | undefined;
  sessionIdentityVersion?: 1 | undefined;
  id: string;
  names: string[];
  evidence: "invoke" | "read" | "load";
  at: string;
}
interface Cursor {
  identity: string;
  offset: number;
  mtimeMs: number;
  cwd: string;
  sessionId: string;
  groupSessionId?: string | undefined;
  sessionIdentityVersion?: 1 | undefined;
  codexInherited?: boolean | undefined;
  inheritedBefore?: string | undefined;
  pending: Pending[];
  omittedHistory: boolean;
  harness?: SkillHarness | undefined;
  skippingLine?: boolean;
  awaitingAppend?: boolean;
  oldestAt?: string;
  newestAt?: string;
  errors?: string[];
}
interface Cache {
  version: 4;
  backfill?: BackfillState;
  files: Record<string, Cursor>;
  events: SkillUsageEvent[];
  omittedEvents: boolean;
  knownFingerprint?: string;
  lastCoverage?: SkillUsageScan["coverage"];
}
// A long-running collector can reuse its validated checkpoint. Disk metadata and
// installation identity must still match; another process writing a checkpoint
// invalidates this entry. Remove before mutation so aborted/failed passes cannot
// expose uncommitted progress to a later scan.
const validatedCaches = new Map<string, { identity: string; cache: Cache }>();
const checkpointIdentity = (info: {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}) => `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
interface Candidate {
  path: string;
  harness: SkillHarness;
  modified: number;
  size: number;
  identity: string;
}
const LIMITS = {
  milliseconds: 1500,
  directories: 256,
  entries: 6000,
  candidates: 192,
  files: 48,
  bytes: 8 * 1024 * 1024,
  perFile: 512 * 1024,
  events: 10000,
};
const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const array = (value: unknown): unknown[] =>
  Array.isArray(value) ? value : [];
const text = (value: unknown): string =>
  typeof value === "string" ? value : "";
function decode(value: unknown): Record<string, unknown> {
  try {
    return object(typeof value === "string" ? JSON.parse(value) : value);
  } catch {
    return {};
  }
}
function successfulOutput(value: unknown): boolean {
  const decoded = decode(value);
  if (decoded.exit_code === 0) return true;
  if (typeof value === "string") {
    // Match the harness-owned header only, never text inside the command's output.
    if (
      /^(?:Chunk ID: [^\n]+\n)?Wall time: [0-9.]+ seconds\nProcess exited with code 0\n(?:Original token count: \d+\n)?Output:(?:\n|$)/.test(
        value,
      )
    )
      return true;
    if (
      /^Exit code: 0\nWall time: [0-9.]+ seconds\n(?:Total output lines: \d+\n)?Output:(?:\n|$)/.test(
        value,
      )
    )
      return true;
  }
  // Codex exec wraps process results in MCP text blocks; their output is never stored.
  return array(value).some((item) => decode(object(item).text).exit_code === 0);
}

/** Structured invocation/read evidence only. Reading a skill does not prove its advice was followed. */
export async function scanSkillUsage(options: {
  env: NodeJS.ProcessEnv;
  cachePath: string;
  knownSkills: Array<{ name: string; paths?: string[] | undefined }>;
  signal?: AbortSignal | undefined;
  mode?: "tail" | "backfill";
  restartBackfill?: boolean;
}): Promise<SkillUsageScan> {
  if (options.signal?.aborted)
    return {
      version: 2,
      usage: [],
      history: [],
      coverage: {
        status: "incomplete",
        filesDiscovered: 0,
        filesScanned: 0,
        bytesRead: 0,
        limitsHit: ["aborted"],
        observedAt: new Date().toISOString(),
      },
    };
  const directory = usageDirectory(options.cachePath);
  return withUsageLock(
    join(directory, "collector.lock"),
    () => scanLocked(options),
    options.signal,
  );
}
async function scanLocked(options: {
  env: NodeJS.ProcessEnv;
  cachePath: string;
  knownSkills: Array<{ name: string; paths?: string[] | undefined }>;
  signal?: AbortSignal | undefined;
  mode?: "tail" | "backfill";
  restartBackfill?: boolean;
}): Promise<SkillUsageScan> {
  const backfill = options.mode === "backfill";
  const cachePath = backfill
    ? `${options.cachePath}.backfill`
    : options.cachePath;
  const directory = usageDirectory(options.cachePath);
  const started = Date.now();
  const limits = new Set<string>();
  const coverage: SkillUsageScan["coverage"] = {
    status: "complete",
    filesDiscovered: 0,
    filesScanned: 0,
    bytesRead: 0,
    limitsHit: [],
    observedAt: new Date().toISOString(),
  };
  const stopped = () => {
    if (options.signal?.aborted) {
      limits.add("aborted");
      return true;
    }
    if (Date.now() - started >= LIMITS.milliseconds) {
      limits.add("time");
      return true;
    }
    return false;
  };
  const names = new Set(options.knownSkills.map((skill) => skill.name));
  const pathNames = new Map<string, string>();
  for (const skill of options.knownSkills) {
    for (const path of skill.paths ?? []) {
      if (stopped()) break;
      const lexical = resolve(
        path.endsWith("SKILL.md") ? path : join(path, "SKILL.md"),
      );
      try {
        const canonical = await realpath(lexical);
        const matched = `${skill.name}\0${digest(canonical)}`;
        pathNames.set(lexical, matched);
        pathNames.set(canonical, matched);
      } catch {
        // A missing installation cannot establish identity for a historical read.
      }
    }
  }
  if (limits.has("time") || limits.has("aborted"))
    throw new Error(
      "Skill installation verification interrupted; saved history is unchanged.",
    );
  const knownPathNames = new Set(pathNames.values());
  const matchName = (name: string): string[] => (names.has(name) ? [name] : []);
  const matchPath = (value: unknown, cwd: string): string[] => {
    const path = text(value);
    if (!path || basename(path) !== "SKILL.md" || (!isAbsolute(path) && !cwd))
      return [];
    const known = pathNames.get(resolve(cwd || "/", path));
    return known ? [known] : [];
  };
  // Deliberately excludes shell expressions, pipelines, globs and command substitutions.
  const commandReads = (cmd: string, cwd: string): string[] => {
    if (!/^\s*cat\s+/.test(cmd) || /[\n\r;|&$`<>*?]/.test(cmd)) return [];
    // Shell word concatenation and escapes can make a quoted path only a fragment.
    // Require whitespace-separated literal arguments before attributing a read.
    if (
      !/^cat\s+(?:'[^']*'|"[^"\\]*"|[^\s'"\\]+)(?:\s+(?:'[^']*'|"[^"\\]*"|[^\s'"\\]+))*$/.test(
        cmd.trim(),
      )
    )
      return [];
    const tokens =
      cmd.trim().match(/'(?:[^']*)'|"(?:[^"\\]*)"|[^\s'"]+/g) ?? [];
    if (tokens.shift() !== "cat" || !tokens.length) return [];
    if (tokens.some((token) => token.startsWith("-"))) return [];
    return [
      ...new Set(
        tokens.flatMap((token) =>
          matchPath(token.replace(/^['"]|['"]$/g, ""), cwd),
        ),
      ),
    ];
  };
  const knownFingerprint = digest(
    JSON.stringify(
      [...pathNames.entries()].sort(([a], [b]) => a.localeCompare(b)),
    ) +
      JSON.stringify(
        options.knownSkills
          .map((skill) => ({
            name: skill.name,
            paths: [...(skill.paths ?? [])].sort(),
          }))
          .sort((a, b) => a.name.localeCompare(b.name)),
      ),
  );
  let cache: Cache = {
    version: 4,
    files: {},
    events: [],
    omittedEvents: false,
  };
  try {
    const handle = await open(
      cachePath,
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    );
    let stored: Record<string, unknown> = {};
    let reused = false;
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.size > 64 * 1024 * 1024)
        throw new Error("invalid cache file");
      const validated = validatedCaches.get(cachePath);
      validatedCaches.delete(cachePath);
      if (
        validated?.identity === checkpointIdentity(info) &&
        validated.cache.knownFingerprint === knownFingerprint
      ) {
        cache = validated.cache;
        reused = true;
      } else {
        const buffer = Buffer.alloc(
          Math.min(info.size + 1, 64 * 1024 * 1024 + 1),
        );
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        if (bytesRead > 64 * 1024 * 1024) throw new Error("oversized cache");
        stored = decode(buffer.subarray(0, bytesRead).toString("utf8"));
      }
    } finally {
      await handle.close();
    }
    if (!reused) {
      if (stored.version !== 4) throw new Error("cache version");
      if (backfill && stored.backfill) {
        const parsed = z
          .object({
            queue: z
              .array(
                z.object({
                  path: z.string().refine(isAbsolute),
                  harness: z.enum(["codex", "claude", "pi"]),
                  skip: z.number().int().nonnegative(),
                  identity: z.string().optional(),
                  modified: z.number().optional(),
                }),
              )
              .max(100000),
            pending: z
              .array(
                z.object({
                  path: z.string().refine(isAbsolute),
                  harness: z.enum(["codex", "claude", "pi"]),
                  modified: z.number(),
                  size: z.number().int().nonnegative(),
                  identity: z.string(),
                }),
              )
              .max(BACKFILL_BATCH_SIZE),
            completed: z.boolean(),
            filesDiscovered: z.number().int().nonnegative(),
            skipped: z.array(z.string()).max(100),
          })
          .safeParse(stored.backfill);
        if (parsed.success) cache.backfill = parsed.data;
        else limits.add("cache_unavailable");
      }
      cache.omittedEvents = stored.omittedEvents === true;
      cache.knownFingerprint = text(stored.knownFingerprint);
      const previousCoverage = skillUsageScanSchema.shape.coverage.safeParse(
        stored.lastCoverage,
      );
      if (previousCoverage.success) cache.lastCoverage = previousCoverage.data;
      for (const [key, value] of Object.entries(object(stored.files)).slice(
        0,
        backfill ? 100000 : LIMITS.candidates,
      )) {
        const cursor = object(value);
        if (
          !/^[a-f0-9]{64}$/.test(key) ||
          typeof cursor.identity !== "string" ||
          !Number.isSafeInteger(cursor.offset) ||
          Number(cursor.offset) < 0
        )
          continue;
        cache.files[key] = {
          identity: cursor.identity,
          offset: Number(cursor.offset),
          mtimeMs: Number(cursor.mtimeMs) || 0,
          sessionId: text(cursor.sessionId).slice(0, 256),
          groupSessionId:
            text(cursor.groupSessionId).slice(0, 256) || undefined,
          sessionIdentityVersion:
            cursor.sessionIdentityVersion === 1 ? 1 : undefined,
          codexInherited: cursor.codexInherited === true,
          inheritedBefore: Number.isFinite(
            Date.parse(text(cursor.inheritedBefore)),
          )
            ? text(cursor.inheritedBefore)
            : undefined,
          harness: ["codex", "claude", "pi"].includes(text(cursor.harness))
            ? (cursor.harness as SkillHarness)
            : undefined,
          skippingLine: cursor.skippingLine === true,
          awaitingAppend: cursor.awaitingAppend === true,
          ...(text(cursor.oldestAt) ? { oldestAt: text(cursor.oldestAt) } : {}),
          ...(text(cursor.newestAt) ? { newestAt: text(cursor.newestAt) } : {}),
          errors: array(cursor.errors).map(text),
          cwd: isAbsolute(text(cursor.cwd)) ? text(cursor.cwd) : "",
          omittedHistory: cursor.omittedHistory === true,
          pending: array(cursor.pending)
            .slice(-128)
            .flatMap((value) => {
              const pending = object(value);
              const skillNames = array(pending.names).flatMap((name) =>
                names.has(text(name).split("\0")[0]!) &&
                (!text(name).includes("\0") || knownPathNames.has(text(name)))
                  ? [text(name)]
                  : [],
              );
              return text(pending.id).length <= 256 &&
                skillNames.length &&
                ["invoke", "read", "load"].includes(text(pending.evidence)) &&
                Number.isFinite(Date.parse(text(pending.at)))
                ? [
                    {
                      id: text(pending.id),
                      groupSessionId:
                        text(pending.groupSessionId).slice(0, 256) || undefined,
                      sessionIdentityVersion:
                        pending.sessionIdentityVersion === 1
                          ? (1 as const)
                          : undefined,
                      names: skillNames,
                      evidence: pending.evidence as Pending["evidence"],
                      at: text(pending.at),
                    },
                  ]
                : [];
            }),
        };
      }
      cache.events = array(stored.events)
        .slice(-LIMITS.events)
        .flatMap((value) => {
          const event = object(value);
          return /^[a-f0-9]{64}$/.test(text(event.id)) &&
            names.has(text(event.name)) &&
            (event.evidence !== "read" ||
              knownPathNames.has(
                `${text(event.name)}\0${text(event.pathId)}`,
              )) &&
            ["codex", "claude", "pi"].includes(text(event.harness)) &&
            ["invoke", "read", "load"].includes(text(event.evidence)) &&
            Number.isFinite(Date.parse(text(event.at)))
            ? [
                {
                  id: text(event.id),
                  name: text(event.name),
                  harness: event.harness as SkillHarness,
                  evidence: event.evidence as SkillUsageEvent["evidence"],
                  at: text(event.at),
                  ...(event.sessionIdentityVersion === 1
                    ? { sessionIdentityVersion: 1 as const }
                    : {}),
                  ...(event.pathId ? { pathId: text(event.pathId) } : {}),
                  ...(/^[a-f0-9]{64}$/.test(text(event.sessionId))
                    ? { sessionId: text(event.sessionId) }
                    : {}),
                },
              ]
            : [];
        });
    }
  } catch (error) {
    validatedCaches.delete(cachePath);
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      limits.add("cache_unavailable");
  }
  if (cache.knownFingerprint !== knownFingerprint) {
    cache.files = {};
    delete cache.backfill;
  }
  cache.knownFingerprint = knownFingerprint;
  const events = new Map(cache.events.map((event) => [event.id, event]));
  const journal = await readUsageJournal(directory);
  for (const event of journal.events)
    if (
      names.has(event.name) &&
      (!event.pathId || knownPathNames.has(`${event.name}\0${event.pathId}`))
    ) {
      events.set(event.id, mergeUsageEvent(events.get(event.id), event));
    }
  if (journal.truncated) limits.add("journal_window");
  const journalEvents = new Map(
    journal.events.map((event) => [event.id, event]),
  );
  // Correct old Pi boundary attributions only when an existing cursor proves
  // this exact native session was forked. Preserve events and raw usage counts.
  // This is linear in retained cursors/events and does not replay any transcript.
  const piForkBoundaries = new Map<string, number>();
  for (const cursor of Object.values(cache.files)) {
    if (cursor.harness !== "pi" || !cursor.sessionId || !cursor.inheritedBefore)
      continue;
    const boundary = Date.parse(cursor.inheritedBefore);
    if (!Number.isFinite(boundary)) continue;
    const session = digest(`pi:${cursor.sessionId}`);
    piForkBoundaries.set(
      session,
      Math.max(piForkBoundaries.get(session) ?? -Infinity, boundary),
    );
  }
  for (const event of events.values()) {
    if (event.harness !== "pi" || !event.sessionId) continue;
    const boundary = piForkBoundaries.get(event.sessionId);
    if (boundary !== undefined && Date.parse(event.at) <= boundary) {
      events.set(
        event.id,
        mergeUsageEvent(event, {
          ...event,
          sessionId: undefined,
          sessionIdentityVersion: 1,
        }),
      );
    }
  }
  // One lookup per verified header upgrades retained legacy root-session events
  // without replaying transcript bodies or resetting historical file offsets.
  const legacyCodexEventsByThread = new Map<string, string[]>();
  for (const event of events.values()) {
    if (
      event.harness !== "codex" ||
      event.sessionIdentityVersion === 1 ||
      !event.sessionId
    )
      continue;
    const ids = legacyCodexEventsByThread.get(event.sessionId) ?? [];
    ids.push(event.id);
    legacyCodexEventsByThread.set(event.sessionId, ids);
  }

  const home = options.env.HOME || options.env.USERPROFILE;
  const roots: Array<{ path: string; harness: SkillHarness }> = home
    ? [
        {
          path: join(
            options.env.CODEX_HOME || join(home, ".codex"),
            "sessions",
          ),
          harness: "codex",
        },
        {
          path: join(
            options.env.CODEX_HOME || join(home, ".codex"),
            "archived_sessions",
          ),
          harness: "codex",
        },
        {
          path: join(
            options.env.CLAUDE_CONFIG_DIR || join(home, ".claude"),
            "projects",
          ),
          harness: "claude",
        },
        {
          path: join(
            options.env.PI_CODING_AGENT_DIR || join(home, ".pi/agent"),
            "sessions",
          ),
          harness: "pi",
        },
      ]
    : [];
  if (!home) limits.add("home_unavailable");
  const candidates: Candidate[] = [];
  const budgets = {
    codex: { directories: 0, entries: 0, candidates: 0 },
    claude: { directories: 0, entries: 0, candidates: 0 },
    pi: { directories: 0, entries: 0, candidates: 0 },
  };
  const discover = async (
    path: string,
    harness: SkillHarness,
    depth: number,
  ): Promise<void> => {
    if (stopped()) return;
    const budget = budgets[harness];
    if (
      depth > 6 ||
      budget.directories++ >= Math.floor(LIMITS.directories / 3)
    ) {
      limits.add("directories");
      return;
    }
    const children: Array<{
      path: string;
      directory: boolean;
      modified: number;
      size: number;
      identity: string;
    }> = [];
    try {
      const dir = await opendir(path);
      for await (const entry of dir) {
        if (stopped()) break;
        if (++budget.entries > LIMITS.entries / 3) {
          limits.add("entries");
          break;
        }
        if (
          entry.isSymbolicLink() ||
          (!entry.isDirectory() &&
            (!entry.isFile() || !entry.name.endsWith(".jsonl")))
        )
          continue;
        const child = join(path, entry.name);
        try {
          const info = await stat(child);
          children.push({
            path: child,
            directory: entry.isDirectory(),
            modified: info.mtimeMs,
            size: info.size,
            identity: `${info.dev}:${info.ino}`,
          });
        } catch {
          limits.add("unreadable");
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        limits.add("unreadable");
      return;
    }
    for (const child of children.sort((a, b) => b.modified - a.modified)) {
      if (stopped()) break;
      if (child.directory) {
        if (budget.entries <= LIMITS.entries / 3)
          await discover(child.path, harness, depth + 1);
      } else if (budget.candidates < LIMITS.candidates / 3) {
        candidates.push({ ...child, harness });
        budget.candidates += 1;
      } else limits.add("files");
    }
  };
  if (backfill) {
    if (options.restartBackfill) cache.backfill = newBackfillState(roots);
    cache.backfill ??= newBackfillState(roots);
    const pending: Candidate[] = [];
    for (const file of cache.backfill.pending) {
      try {
        const info = await lstat(file.path);
        if (info.isFile())
          pending.push({
            ...file,
            size: info.size,
            modified: info.mtimeMs,
            identity: `${info.dev}:${info.ino}`,
          });
        else cache.backfill.skipped.push("non_regular_file");
      } catch {
        cache.backfill.skipped.push("missing_or_unreadable");
      }
    }
    cache.backfill.pending = pending;
    await discoverBackfill(cache.backfill, stopped);
    candidates.push(...cache.backfill.pending);
    coverage.filesDiscovered = cache.backfill.filesDiscovered;
    for (const reason of cache.backfill.skipped) limits.add(reason);
  } else {
    await Promise.all(
      roots.map((root) => discover(root.path, root.harness, 0)),
    );
    coverage.filesDiscovered = candidates.length;
  }
  const complete = (
    cursor: Cursor,
    harness: SkillHarness,
    id: string,
    ok: boolean,
  ) => {
    const index = cursor.pending.findIndex((item) => item.id === id);
    if (index < 0) return;
    const pending = cursor.pending.splice(index, 1)[0]!;
    if (!ok) return;
    for (const matched of pending.names) {
      const [name, pathId] = matched.split("\0") as [
        string,
        string | undefined,
      ];
      const key = usageEventId(
        harness,
        pending.evidence === "load" ? "" : cursor.sessionId,
        id,
        name,
        pathId,
        pending.evidence,
      );
      const groupSessionId =
        harness === "codex" ? pending.groupSessionId : cursor.sessionId;
      const event: SkillUsageEvent = {
        id: key,
        name,
        harness,
        evidence: pending.evidence,
        at: pending.at,
        ...(groupSessionId
          ? { sessionId: digest(`${harness}:${groupSessionId}`) }
          : {}),
        ...(pending.sessionIdentityVersion === 1
          ? { sessionIdentityVersion: 1 as const }
          : {}),
        ...(pathId ? { pathId } : {}),
      };
      events.set(key, mergeUsageEvent(events.get(key), event));
    }
  };
  const processRecord = (
    record: Record<string, unknown>,
    cursor: Cursor,
    harness: SkillHarness,
  ) => {
    const payload = object(record.payload),
      message = object(record.message);
    if (harness === "codex") {
      const identity = extractCodexSessionIdentity(record);
      if (identity) {
        cursor.sessionId = identity.threadId;
        cursor.groupSessionId = identity.sessionId;
        cursor.sessionIdentityVersion = 1;
        cursor.codexInherited = identity.inherited;
        cursor.inheritedBefore = identity.inherited
          ? identity.startedAt
          : undefined;
        if (!identity.inherited && identity.sessionId) {
          const legacyIdentity = digest(`codex:${identity.threadId}`);
          for (const id of legacyCodexEventsByThread.get(legacyIdentity) ??
            []) {
            const previous = events.get(id)!;
            events.set(
              id,
              mergeUsageEvent(previous, {
                ...previous,
                sessionId: digest(`codex:${identity.sessionId}`),
                sessionIdentityVersion: 1,
              }),
            );
          }
          legacyCodexEventsByThread.delete(legacyIdentity);
        }
      }
    } else {
      const sessionId =
        text(record.sessionId) ||
        (record.type === "session" ? text(record.id) : "");
      if (
        sessionId &&
        sessionId.length <= 256 &&
        !/[\x00-\x20\x7f]/.test(sessionId)
      )
        cursor.sessionId = sessionId;
    }
    // A child or fork can contain copied response items. Only original item
    // creation metadata after its creation boundary proves execution there.
    const originalAt =
      harness === "codex" ? codexRecordCreatedAt(record) : undefined;
    if (
      harness === "codex" &&
      record.type === "response_item" &&
      cursor.codexInherited &&
      originalAt &&
      cursor.inheritedBefore &&
      Date.parse(originalAt) <= Date.parse(cursor.inheritedBefore)
    ) {
      cursor.omittedHistory = true;
      return;
    }
    const codexSessionKnown =
      cursor.sessionIdentityVersion === 1 &&
      (!cursor.codexInherited ||
        Boolean(
          originalAt &&
            cursor.inheritedBefore &&
            Date.parse(originalAt) > Date.parse(cursor.inheritedBefore),
        ));
    const sessionAttribution =
      harness === "codex"
        ? {
            sessionIdentityVersion: 1 as const,
            ...(codexSessionKnown && cursor.groupSessionId
              ? { groupSessionId: cursor.groupSessionId }
              : {}),
          }
        : {};
    if (
      harness === "pi" &&
      record.type === "session" &&
      record.parentSession &&
      Number.isFinite(Date.parse(text(record.timestamp)))
    )
      cursor.inheritedBefore = text(record.timestamp);
    // Pi forks copy earlier entries verbatim into a new session, sometimes with a
    // different cwd. Do not treat those copies as fresh executions at the new cwd.
    // Equal millisecond timestamps are ambiguous too; omit that boundary rather
    // than claim a copied execution belonged to the new session.
    if (
      harness === "pi" &&
      record.type === "message" &&
      cursor.inheritedBefore &&
      Date.parse(text(record.timestamp)) <= Date.parse(cursor.inheritedBefore)
    ) {
      cursor.omittedHistory = true;
      return;
    }
    const contextPath =
      text(record.cwd) ||
      (["session_meta", "turn_context"].includes(text(record.type))
        ? text(payload.cwd)
        : "");
    if (isAbsolute(contextPath)) cursor.cwd = contextPath;
    const at =
      text(record.timestamp) ||
      (typeof message.timestamp === "number"
        ? new Date(message.timestamp).toISOString()
        : text(message.timestamp));
    if (Number.isFinite(Date.parse(at))) {
      if (!cursor.oldestAt || Date.parse(at) < Date.parse(cursor.oldestAt))
        cursor.oldestAt = at;
      if (!cursor.newestAt || Date.parse(at) > Date.parse(cursor.newestAt))
        cursor.newestAt = at;
    }
    if (harness === "codex")
      for (const event of extractCodexSkillEvents(record)) {
        const matched = matchPath(event.path, cursor.cwd);
        if (!matched.length || !event.at) continue;
        cursor.pending.push({
          id: event.id,
          names: matched,
          evidence: "load",
          at: event.at,
          ...sessionAttribution,
        });
        complete(cursor, harness, event.id, true);
      }
    const add = (id: unknown, name: unknown, value: unknown) => {
      const args = object(value);
      let matched: string[] = [],
        evidence: Pending["evidence"] = "read";
      if (harness === "claude" && name === "Skill") {
        matched = matchName(text(args.skill));
        evidence = "invoke";
      } else if (["read", "Read", "read_file"].includes(text(name)))
        matched = matchPath(args.path ?? args.file_path, cursor.cwd);
      else if (
        ["exec_command", "shell_command", "Bash", "bash"].includes(text(name))
      )
        matched = commandReads(
          text(args.cmd ?? args.command),
          text(args.workdir) || cursor.cwd,
        );
      else if (
        harness === "codex" &&
        name === "exec" &&
        typeof value === "string"
      ) {
        // Accept a single awaited call wrapper, never general JavaScript or quoted examples.
        const wrapper = value.match(
          /^\s*(?:text\()?\s*await tools\.exec_command\((\{[\s\S]*\})\)\)?;?\s*$/,
        );
        if (wrapper) {
          const literal = wrapper[1]!.replace(
            /([{,]\s*)([A-Za-z_][A-Za-z_0-9]*)\s*:/g,
            '$1"$2":',
          );
          const command = decode(literal);
          matched = commandReads(
            text(command.cmd),
            text(command.workdir) || cursor.cwd,
          );
        }
      }
      if (
        matched.length &&
        text(id) &&
        text(id).length <= 256 &&
        at.length <= 40 &&
        Number.isFinite(Date.parse(at))
      ) {
        cursor.pending = cursor.pending.filter((item) => item.id !== id);
        cursor.pending.push({
          id: text(id),
          names: matched,
          evidence,
          at,
          ...sessionAttribution,
        });
        if (cursor.pending.length > 128) {
          cursor.pending.shift();
          limits.add("pending_calls");
        }
      }
    };
    if (harness === "codex" && record.type === "response_item") {
      if (["function_call", "custom_tool_call"].includes(text(payload.type)))
        add(
          payload.call_id,
          payload.name,
          payload.type === "function_call"
            ? decode(payload.arguments)
            : payload.input,
        );
      if (
        ["function_call_output", "custom_tool_call_output"].includes(
          text(payload.type),
        )
      )
        complete(
          cursor,
          harness,
          text(payload.call_id),
          successfulOutput(payload.output),
        );
    } else {
      for (const value of array(message.content)) {
        const item = object(value);
        if (
          ["tool_use", "toolCall"].includes(text(item.type)) &&
          (message.role === "assistant" || record.type === "assistant")
        )
          add(item.id, item.name, item.input ?? item.arguments);
        if (item.type === "tool_result")
          complete(
            cursor,
            harness,
            text(item.tool_use_id),
            item.is_error !== true,
          );
      }
      if (message.role === "toolResult")
        complete(
          cursor,
          harness,
          text(message.toolCallId),
          message.isError === false,
        );
    }
  };
  const ordered = candidates.sort((a, b) =>
    backfill ? a.modified - b.modified : b.modified - a.modified,
  );
  const fileBudget = backfill ? BACKFILL_BATCH_SIZE : LIMITS.files;
  if (ordered.length > fileBudget) limits.add("files");
  const fairFiles: Candidate[] = [];
  const byHarness = (["codex", "claude", "pi"] as const).map((harness) =>
    ordered.filter((file) => file.harness === harness),
  );
  for (
    let index = 0;
    index < fileBudget && fairFiles.length < fileBudget;
    index += 1
  )
    for (const files of byHarness) {
      if (files[index] && fairFiles.length < fileBudget)
        fairFiles.push(files[index]!);
    }
  for (const file of fairFiles) {
    if (stopped()) break;
    if (coverage.bytesRead >= LIMITS.bytes) {
      limits.add("bytes");
      break;
    }
    const key = digest(file.path);
    let cursor = cache.files[key];
    if (
      !cursor ||
      cursor.identity !== file.identity ||
      file.size < cursor.offset ||
      (file.size === cursor.offset && file.modified !== cursor.mtimeMs)
    )
      cursor = {
        identity: file.identity,
        harness: file.harness,
        offset: 0,
        mtimeMs: 0,
        cwd: "",
        sessionId: "",
        pending: [],
        omittedHistory: false,
      };
    const needsSessionHeader =
      file.harness === "codex" && cursor.sessionIdentityVersion !== 1;
    if (
      cursor.offset === file.size &&
      cursor.mtimeMs === file.modified &&
      !needsSessionHeader
    ) {
      cache.files[key] = cursor;
      continue;
    }
    let offset = cursor.offset;
    let discard = cursor.skippingLine === true;
    if (!backfill && file.size - offset > LIMITS.perFile) {
      offset = file.size - LIMITS.perFile;
      discard = true;
      cursor.omittedHistory = true;
      cursor.pending = [];
    }
    try {
      const handle = await open(
        file.path,
        constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
      );
      try {
        const openedInfo = await handle.stat();
        if (`${openedInfo.dev}:${openedInfo.ino}` !== file.identity) {
          limits.add("changed_file");
          continue;
        }
        if (!openedInfo.isFile()) {
          limits.add("non_regular_file");
          continue;
        }
        if (
          offset > 0 &&
          (!cursor.sessionId || needsSessionHeader) &&
          coverage.bytesRead < LIMITS.bytes
        ) {
          // Session headers restore identity/cwd when the bounded window starts mid-file.
          const header = Buffer.alloc(
            Math.min(32768, LIMITS.bytes - coverage.bytesRead),
          );
          const head = await handle.read(header, 0, header.length, 0);
          coverage.bytesRead += head.bytesRead;
          const end = header.indexOf(10);
          if (end >= 0 && end < head.bytesRead) {
            const record = decode(header.subarray(0, end).toString("utf8"));
            if (["session", "session_meta"].includes(text(record.type)))
              processRecord(record, cursor, file.harness);
          }
        }
        const buffer = Buffer.alloc(
          Math.min(
            file.size - offset,
            LIMITS.perFile,
            LIMITS.bytes - coverage.bytesRead,
          ),
        );
        const { bytesRead } = await handle.read(
          buffer,
          0,
          buffer.length,
          offset,
        );
        coverage.bytesRead += bytesRead;
        coverage.filesScanned += 1;
        let start = 0;
        while (start < bytesRead && !stopped()) {
          const end = buffer.indexOf(10, start);
          if (end < 0 || end >= bytesRead) break;
          if (discard) {
            discard = false;
            cursor.skippingLine = false;
          } else {
            try {
              processRecord(
                object(
                  JSON.parse(buffer.subarray(start, end).toString("utf8")),
                ),
                cursor,
                file.harness,
              );
            } catch {
              limits.add("malformed_records");
              cursor.errors = [
                ...new Set([...(cursor.errors ?? []), "malformed_records"]),
              ];
            }
          }
          start = end + 1;
        }
        cursor.offset = offset + start;
        cursor.awaitingAppend =
          start < bytesRead && offset + bytesRead === file.size;
        if (cursor.awaitingAppend) limits.add("partial_record");
        if (!start && bytesRead === LIMITS.perFile) {
          cursor.offset = offset + bytesRead;
          cursor.omittedHistory = true;
          cursor.skippingLine = true;
          limits.add("oversized_record");
        }
        cursor.mtimeMs = file.modified;
        cache.files[key] = cursor;
      } finally {
        await handle.close();
      }
    } catch {
      limits.add("unreadable");
      if (backfill) {
        cache.backfill?.skipped.push("unreadable");
        cache.files[key] = {
          ...cursor,
          offset: file.size,
          errors: ["unreadable"],
        };
      }
    }
  }
  const retained = [...events.values()].sort(
    (a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id),
  );
  if (retained.length > LIMITS.events) cache.omittedEvents = true;
  cache.events = retained.slice(-LIMITS.events);
  if (backfill && cache.backfill) {
    cache.backfill.pending = candidates.filter((file) => {
      const cursor = cache.files[digest(file.path)];
      return !cursor || (cursor.offset < file.size && !cursor.awaitingAppend);
    });
    // A final torn line is deferred to the next traversal/tail; never block other files.
    cache.backfill.completed =
      !cache.backfill.queue.length && !cache.backfill.pending.length;
    if (!cache.backfill.completed) limits.add("backfill_pending");
  }
  const currentKeys = new Set(ordered.map((file) => digest(file.path)));
  if (!backfill)
    cache.files = Object.fromEntries(
      Object.entries(cache.files)
        .filter(([key]) => currentKeys.has(key))
        .slice(-LIMITS.candidates),
    );
  if (
    cache.omittedEvents ||
    Object.values(cache.files).some((cursor) => cursor.omittedHistory)
  )
    limits.add("history_window");
  const harnessCoverage: HarnessUsageCoverage[] = (
    ["codex", "claude", "pi"] as const
  ).map((harness) => {
    const cursors = Object.values(cache.files).filter(
      (cursor) => cursor.harness === harness,
    );
    let oldest: string | undefined, newest: string | undefined;
    let oldestTime = Infinity,
      newestTime = -Infinity;
    for (const cursor of cursors) {
      const start = cursor.oldestAt ? Date.parse(cursor.oldestAt) : NaN;
      const end = cursor.newestAt ? Date.parse(cursor.newestAt) : NaN;
      if (start < oldestTime) {
        oldestTime = start;
        oldest = cursor.oldestAt;
      }
      if (end > newestTime) {
        newestTime = end;
        newest = cursor.newestAt;
      }
    }
    const pending = cursors.reduce((sum, c) => sum + c.pending.length, 0);
    const limitations = [
      ...new Set([
        ...(backfill
          ? cache.backfill?.queue.some((item) => item.harness === harness) ||
            cache.backfill?.pending.some((item) => item.harness === harness)
            ? ["backfill_pending"]
            : []
          : [...limits]),
        ...(backfill ? (cache.backfill?.skipped ?? []) : []),
        ...cursors.flatMap((c) => (c.omittedHistory ? ["history_window"] : [])),
        ...cursors.flatMap((c) => (c.awaitingAppend ? ["partial_record"] : [])),
        ...cursors.flatMap((c) => c.errors ?? []),
        ...(pending ? ["pending_results"] : []),
      ]),
    ];
    return {
      harness,
      status:
        limitations.length || !backfill
          ? "partial"
          : cursors.length
            ? "scanned"
            : "absent",
      filesScanned: cursors.length,
      pendingCalls: pending,
      ...(oldest ? { oldestAt: oldest } : {}),
      ...(newest ? { newestAt: newest } : {}),
      limitations,
    };
  });
  const backfillReport = cache.backfill
    ? {
        complete: cache.backfill.completed,
        filesDiscovered: cache.backfill.filesDiscovered,
        filesPending: cache.backfill.pending.length,
      }
    : undefined;
  let historical:
    | {
        harnessCoverage: HarnessUsageCoverage[];
        backfill: NonNullable<SkillUsageScan["backfill"]>;
      }
    | undefined;
  if (!backfill)
    try {
      const saved = JSON.parse(
        await readFile(join(directory, "coverage.json"), "utf8"),
      );
      if (saved.fingerprint === knownFingerprint) {
        const parsed = skillUsageScanSchema.shape.harnessCoverage.safeParse(
          saved.harnessCoverage,
        );
        const progress = skillUsageScanSchema.shape.backfill.safeParse(
          saved.backfill,
        );
        if (parsed.success && parsed.data && progress.success && progress.data)
          historical = {
            harnessCoverage: parsed.data,
            backfill: progress.data,
          };
      }
    } catch {}
  const usage = new Map<string, SkillUsage>();
  for (const event of cache.events) {
    const key = `${event.name}:${event.harness}:${event.evidence}:${event.pathId ?? ""}`;
    const current = usage.get(key);
    if (current) {
      current.count += 1;
      if (Date.parse(event.at) > Date.parse(current.lastUsedAt))
        current.lastUsedAt = event.at;
    } else
      usage.set(key, {
        name: event.name,
        harness: event.harness,
        evidence: event.evidence,
        count: 1,
        lastUsedAt: event.at,
        ...(event.pathId ? { pathId: event.pathId } : {}),
      });
  }
  coverage.limitsHit = [...limits].sort();
  coverage.status = limits.size ? "incomplete" : "complete";
  if (
    !coverage.bytesRead &&
    cache.lastCoverage?.filesDiscovered === coverage.filesDiscovered &&
    JSON.stringify(cache.lastCoverage.limitsHit) ===
      JSON.stringify(coverage.limitsHit)
  )
    Object.assign(coverage, cache.lastCoverage);
  cache.lastCoverage = coverage;
  if (!options.signal?.aborted) {
    try {
      await appendUsageEvents(
        directory,
        retained.filter(
          (event) =>
            !journalEvents.has(event.id) ||
            Date.parse(event.at) <
              Date.parse(journalEvents.get(event.id)!.at) ||
            event.sessionIdentityVersion !==
              journalEvents.get(event.id)!.sessionIdentityVersion ||
            event.sessionId !== journalEvents.get(event.id)!.sessionId,
        ),
      );
      await saveUsageManifest(directory, options.knownSkills);
      await mkdir(dirname(cachePath), { recursive: true });
      const pending = `${cachePath}.${randomUUID()}.tmp`;
      await writeFile(pending, JSON.stringify(cache), { mode: 0o600 });
      // Keep the file handle across rename: ctime can change when a file moves.
      const checkpointHandle = await open(
        pending,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      let checkpoint;
      try {
        await rename(pending, cachePath);
        checkpoint = await checkpointHandle.stat();
      } finally {
        await checkpointHandle.close();
      }
      if (backfillReport)
        await atomicUsageJson(join(directory, "coverage.json"), {
          fingerprint: knownFingerprint,
          harnessCoverage,
          backfill: backfillReport,
        });
      validatedCaches.set(cachePath, {
        identity: checkpointIdentity(checkpoint),
        cache,
      });
      if (validatedCaches.size > 2)
        validatedCaches.delete(validatedCaches.keys().next().value!);
    } catch {
      validatedCaches.delete(cachePath);
      limits.add("cache_write_failed");
    }
  }
  coverage.limitsHit = [...limits].sort();
  coverage.status = limits.size ? "incomplete" : "complete";
  return {
    version: 2,
    usage: [...usage.values()].sort(
      (a, b) =>
        a.name.localeCompare(b.name) ||
        a.harness.localeCompare(b.harness) ||
        a.evidence.localeCompare(b.evidence),
    ),
    harnessCoverage: historical?.harnessCoverage ?? harnessCoverage,
    ...(historical ? { backfill: historical.backfill } : {}),
    ...(cache.backfill
      ? {
          backfill: {
            complete: cache.backfill.completed,
            filesDiscovered: cache.backfill.filesDiscovered,
            filesPending: cache.backfill.pending.length,
          },
        }
      : {}),
    history: cache.events.slice(-1000).reverse(),
    sessions: groupUsageSessions(cache.events),
    sessionsTruncated: cache.omittedEvents || journal.truncated,
    historyTruncated: cache.omittedEvents || cache.events.length > 1000,
    coverage,
  };
}
