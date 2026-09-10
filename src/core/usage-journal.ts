import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { SkillHarness, SkillUsageEvent } from "./skill-usage.js";

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export const usageEventId = (
  harness: string,
  session: string,
  call: string,
  name: string,
  path: string | undefined,
  evidence: string,
) => hash(JSON.stringify([harness, session, call, name, path ?? "", evidence]));
export const usageDirectory = (cachePath: string) =>
  join(dirname(cachePath), "usage");

/** Local-filesystem lock. Dead owners can be recovered; live owners are never stolen. */
export async function withUsageLock<T>(
  path: string,
  fn: () => Promise<T>,
  signal?: AbortSignal,
  timeoutMs = 2000,
): Promise<T> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const start = Date.now(),
    token = randomUUID();
  let handle;
  while (!handle) {
    signal?.throwIfAborted();
    try {
      handle = await open(path, "wx", 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, token }));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const info = await lstat(path).catch(() => undefined);
      if (!info) continue;
      if (!info.isFile()) throw new Error("Usage lock is not a regular file");
      let dead = false;
      try {
        const owner = JSON.parse(await readFile(path, "utf8"));
        if (Number.isInteger(owner.pid) && owner.pid > 0) {
          try {
            process.kill(owner.pid, 0);
          } catch (e) {
            dead = (e as NodeJS.ErrnoException).code === "ESRCH";
          }
        }
      } catch {
        dead = Date.now() - info.mtimeMs > 60000;
      }
      if (dead) {
        // Serialize competing recovery attempts; otherwise a second reaper can
        // unlink the new live owner's file after validating the old inode.
        const recovery = await open(`${path}.recovery`, "wx", 0o600).catch(
          () => undefined,
        );
        if (recovery)
          try {
            const current = await lstat(path).catch(() => undefined);
            if (current?.ino === info.ino && current?.mtimeMs === info.mtimeMs)
              await unlink(path).catch(() => {});
          } finally {
            await recovery.close();
            await unlink(`${path}.recovery`).catch(() => {});
          }
      }
      if (Date.now() - start >= timeoutMs)
        throw new Error("Usage collector is busy");
      await delay(25, undefined, signal ? { signal } : {});
    }
  }
  try {
    return await fn();
  } finally {
    await handle.close();
    const owner = await readFile(path, "utf8").catch(() => "");
    if (owner.includes(token)) await unlink(path).catch(() => {});
  }
}

export async function atomicUsageJson(
  path: string,
  value: unknown,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, JSON.stringify(value), { mode: 0o600, flag: "wx" });
    await rename(temp, path);
  } finally {
    await unlink(temp).catch(() => {});
  }
}

/** Append-only normalized journal. Writers serialize; transcripts never enter this file. */
export async function appendUsageEvents(
  directory: string,
  events: SkillUsageEvent[],
): Promise<void> {
  if (!events.length) return;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await lstat(directory)).isDirectory())
    throw new Error("Invalid usage directory");
  await withUsageLock(join(directory, "journal.lock"), async () => {
    const path = join(
      directory,
      `events-${new Date().toISOString().slice(0, 10)}.jsonl`,
    );
    const handle = await open(
      path,
      constants.O_APPEND |
        constants.O_CREAT |
        constants.O_RDWR |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new Error("Invalid usage journal");
      // Preserve an interrupted row as evidence of incomplete coverage, but never
      // concatenate the next valid event onto it. The journal lock owns this tail.
      if (info.size) {
        const tail = Buffer.alloc(1);
        await handle.read(tail, 0, 1, info.size - 1);
        if (tail[0] !== 10) await handle.writeFile("\n");
      }
      const rows = events.map((event) => ({
        version: 1,
        adapter: `${event.harness}-v1`,
        ...publicUsageEvent(event),
      }));
      await handle.writeFile(
        rows.map((event) => JSON.stringify(event)).join("\n") + "\n",
      );
      await handle.sync();
    } finally {
      await handle.close();
    }
  });
}
export function publicUsageEvent(event: SkillUsageEvent): SkillUsageEvent {
  return {
    id: event.id,
    name: event.name,
    harness: event.harness,
    evidence: event.evidence,
    at: event.at,
    ...(event.pathId ? { pathId: event.pathId } : {}),
    ...(event.sessionId ? { sessionId: event.sessionId } : {}),
    ...(event.sessionIdentityVersion === 1
      ? { sessionIdentityVersion: 1 as const }
      : {}),
  };
}
/** Merge repeated observations independently of discovery order. Versioned
 * unknown attribution is conservative: a copied load must never move sessions.
 * A verified observation may upgrade an unversioned legacy attribution.
 */
export function mergeUsageEvent(
  prior: SkillUsageEvent | undefined,
  next: SkillUsageEvent,
): SkillUsageEvent {
  if (!prior) return publicUsageEvent(next);
  const base = Date.parse(next.at) < Date.parse(prior.at) ? next : prior;
  const verified = [prior, next].filter(
    (event) => event.sessionIdentityVersion === 1,
  );
  const candidates = verified.length ? verified : [prior, next];
  const identities = new Set(candidates.map((event) => event.sessionId));
  const sessionId =
    identities.size === 1 ? candidates[0]?.sessionId : undefined;
  const result = publicUsageEvent(base);
  delete result.sessionId;
  if (sessionId) result.sessionId = sessionId;
  // Mark conflicts so another later duplicate cannot restore arbitrary attribution.
  if (verified.length || identities.size > 1) result.sessionIdentityVersion = 1;
  return result;
}

export async function readUsageJournal(
  directory: string,
): Promise<{ events: SkillUsageEvent[]; truncated: boolean }> {
  const names = (await readdir(directory).catch(() => [] as string[]))
    .filter((name) => /^events-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
    .sort()
    .reverse();
  const events = new Map<string, SkillUsageEvent>();
  let budget = 8 * 1024 * 1024,
    truncated = false;
  for (const name of names) {
    if (budget <= 0) {
      truncated = true;
      break;
    }
    const handle = await open(
      join(directory, name),
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    );
    try {
      const info = await handle.stat();
      if (!info.isFile()) {
        truncated = true;
        continue;
      }
      const bytes = Math.min(budget, info.size),
        offset = info.size - bytes;
      const buffer = Buffer.alloc(bytes);
      const read = await handle.read(buffer, 0, bytes, offset);
      budget -= read.bytesRead;
      if (offset) truncated = true;
      const lines = buffer
        .subarray(0, read.bytesRead)
        .toString("utf8")
        .split("\n");
      if (offset) lines.shift();
      if (lines.pop()) truncated = true;
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          if (
            event.version !== 1 ||
            !/^[a-f0-9]{64}$/.test(event.id) ||
            !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(event.name) ||
            !["codex", "claude", "pi"].includes(event.harness) ||
            !["read", "invoke", "load"].includes(event.evidence) ||
            !Number.isFinite(Date.parse(event.at)) ||
            (event.pathId && !/^[a-f0-9]{64}$/.test(event.pathId)) ||
            (event.sessionId && !/^[a-f0-9]{64}$/.test(event.sessionId)) ||
            (event.sessionIdentityVersion !== undefined &&
              event.sessionIdentityVersion !== 1)
          ) {
            truncated = true;
            continue;
          }
          events.set(event.id, mergeUsageEvent(events.get(event.id), event));
        } catch {
          truncated = true;
        }
      }
    } finally {
      await handle.close();
    }
  }
  return { events: [...events.values()], truncated };
}

export async function saveUsageManifest(
  directory: string,
  skills: Array<{ name: string; paths?: string[] | undefined }>,
): Promise<void> {
  const paths: Record<string, { name: string; pathId: string }> = {};
  for (const skill of skills)
    for (const path of skill.paths ?? []) {
      try {
        const lexical = resolve(
          basename(path) === "SKILL.md" ? path : join(path, "SKILL.md"),
        );
        const canonical = await realpath(lexical);
        if (!(await stat(canonical)).isFile()) continue;
        paths[lexical] = paths[canonical] = {
          name: skill.name,
          pathId: hash(canonical),
        };
      } catch {}
    }
  await atomicUsageJson(join(directory, "installations.json"), paths);
}
export interface HookUsageInput {
  harness: SkillHarness;
  sessionId: string;
  callId: string;
  at: string;
  evidence: "read" | "invoke";
  path?: string;
  name?: string;
}
export async function recordHookUsage(
  directory: string,
  input: HookUsageInput,
): Promise<void> {
  if (
    !input.sessionId ||
    !input.callId ||
    !Number.isFinite(Date.parse(input.at))
  )
    return;
  const manifest = JSON.parse(
    await readFile(join(directory, "installations.json"), "utf8"),
  );
  let match: { name: string; pathId?: string } | undefined;
  if (
    input.path &&
    isAbsolute(input.path) &&
    basename(input.path) === "SKILL.md"
  ) {
    const canonical = await realpath(input.path);
    const observed = manifest[input.path] ?? manifest[canonical];
    if (observed?.pathId === hash(canonical)) match = observed;
  } else if (
    input.evidence === "invoke" &&
    input.name &&
    Object.values(manifest).some(
      (value) => (value as { name: string }).name === input.name,
    )
  )
    match = { name: input.name };
  if (!match) return;
  await appendUsageEvents(directory, [
    {
      id: usageEventId(
        input.harness,
        input.sessionId,
        input.callId,
        match.name,
        match.pathId,
        input.evidence,
      ),
      name: match.name,
      harness: input.harness,
      evidence: input.evidence,
      at: input.at,
      sessionId: hash(`${input.harness}:${input.sessionId}`),
      sessionIdentityVersion: 1,
      ...(match.pathId ? { pathId: match.pathId } : {}),
    },
  ]);
}
