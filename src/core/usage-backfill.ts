import { lstat, opendir } from "node:fs/promises";
import { join } from "node:path";
import type { SkillHarness } from "./skill-usage.js";
export interface UsageCandidate {
  path: string;
  harness: SkillHarness;
  modified: number;
  size: number;
  identity: string;
}
export interface BackfillState {
  queue: Array<{
    path: string;
    harness: SkillHarness;
    skip: number;
    identity?: string | undefined;
    modified?: number | undefined;
  }>;
  pending: UsageCandidate[];
  completed: boolean;
  filesDiscovered: number;
  skipped: string[];
}
export const newBackfillState = (
  roots: Array<{ path: string; harness: SkillHarness }>,
): BackfillState => ({
  queue: roots.map((root) => ({ ...root, skip: 0 })),
  pending: [],
  completed: false,
  filesDiscovered: 0,
  skipped: [],
});
/** Persistent breadth-first directory cursor. Retains unfinished directories and files
 * rather than reselecting the newest window on every pass. */
export async function discoverBackfill(
  state: BackfillState,
  stopped: () => boolean,
): Promise<void> {
  let entries = 0;
  while (
    state.queue.length &&
    state.pending.length < 48 &&
    entries < 6000 &&
    !stopped()
  ) {
    // Reserve equal pending capacity for each harness still being discovered.
    // Once its queue is exhausted, unused capacity is available to the others.
    const active = new Set(state.queue.map((item) => item.harness));
    const counts = { codex: 0, claude: 0, pi: 0 };
    for (const candidate of state.pending) counts[candidate.harness]++;
    const reserved = state.pending.filter(
      (item) => !active.has(item.harness),
    ).length;
    const quota = Math.floor((48 - reserved) / active.size);
    const eligible = state.queue.findIndex(
      (item) => counts[item.harness] < quota,
    );
    if (eligible < 0) break;
    if (eligible) state.queue.push(...state.queue.splice(0, eligible));
    const current = state.queue[0]!;
    try {
      const directory = await lstat(current.path);
      if (!directory.isDirectory()) {
        state.skipped.push("non_directory");
        state.queue.shift();
        continue;
      }
      const identity = `${directory.dev}:${directory.ino}`;
      if (
        current.skip &&
        (current.identity !== identity ||
          current.modified !== directory.mtimeMs)
      ) {
        current.skip = 0;
        state.skipped.push("directory_changed");
      }
      current.identity = identity;
      current.modified = directory.mtimeMs;
      const dir = await opendir(current.path);
      let position = 0,
        exhausted = true;
      for await (const entry of dir) {
        if (stopped()) {
          exhausted = false;
          break;
        }
        if (position++ < current.skip) continue;
        if (
          entries >= 6000 ||
          state.pending.length >= 48 ||
          counts[current.harness] >= quota
        ) {
          exhausted = false;
          break;
        }
        current.skip = position;
        entries++;
        if (entry.isSymbolicLink()) continue;
        const path = join(current.path, entry.name);
        if (entry.isDirectory()) {
          if (
            !state.queue.some(
              (item) => item.path === path && item.harness === current.harness,
            )
          )
            state.queue.push({ path, harness: current.harness, skip: 0 });
        } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
          const info = await lstat(path);
          if (!info.isFile()) continue;
          const candidate = {
            path,
            harness: current.harness,
            modified: info.mtimeMs,
            size: info.size,
            identity: `${info.dev}:${info.ino}`,
          };
          const pending = state.pending.findIndex(
            (item) => item.path === path && item.harness === current.harness,
          );
          if (pending < 0) {
            state.pending.push(candidate);
            counts[current.harness]++;
            state.filesDiscovered++;
          } else state.pending[pending] = candidate;
        }
      }
      const after = await lstat(current.path);
      if (
        `${after.dev}:${after.ino}` !== identity ||
        after.mtimeMs !== directory.mtimeMs
      ) {
        // Enumeration order can change while reading. Rescan this directory;
        // existing file cursors and pending-path deduplication prevent double reads.
        current.skip = 0;
        current.identity = `${after.dev}:${after.ino}`;
        current.modified = after.mtimeMs;
        state.skipped.push("directory_changed");
      } else if (exhausted) state.queue.shift();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        state.skipped.push("unreadable");
      state.queue.shift();
    }
    // Path metadata is private, but still bounded against pathological trees.
    if (state.queue.length > 100000) {
      state.skipped.push("directory_limit");
      state.queue = state.queue.slice(0, 100000);
    }
  }
  state.skipped = [...new Set(state.skipped)];
}
