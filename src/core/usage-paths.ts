import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
  type InstallationDirectory,
  installationDirectory,
} from "./installation-directories.js";
import type { InventorySkill, MachineInventory } from "./types.js";

export interface KnownUsagePaths {
  name: string;
  /** Private local evidence paths; publish only InventorySkill.usagePathIds. */
  paths: string[];
}

function candidates(
  skill: InventorySkill,
  cwd: string | undefined,
  env: NodeJS.ProcessEnv,
): string[] {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(skill.name)) return [];
  const paths: string[] = [];
  if (skill.path && (isAbsolute(skill.path) || cwd)) {
    const explicit = isAbsolute(skill.path)
      ? skill.path
      : resolve(cwd!, skill.path);
    paths.push(
      basename(explicit) === "SKILL.md" ? explicit : join(explicit, "SKILL.md"),
    );
  }
  // Only exact recognized installation roots are candidates; never search a workspace
  // for arbitrary matching basenames. Explicit upstream installation paths are trusted.
  const global = skill.scope === "global";
  const base = global ? env.HOME || env.USERPROFILE : cwd;
  const roots: string[] = [];
  if (base) roots.push(join(base, ".agents", "skills"));
  for (const [override, fallback] of [
    [
      global ? env.CODEX_HOME : undefined,
      base ? join(base, ".codex") : undefined,
    ],
    [
      global ? env.CLAUDE_CONFIG_DIR : undefined,
      base ? join(base, ".claude") : undefined,
    ],
    [
      global ? env.PI_CODING_AGENT_DIR : undefined,
      base ? join(base, ".pi", ...(global ? ["agent"] : [])) : undefined,
    ],
  ]) {
    const directory = override?.trim() || fallback;
    if (directory) roots.push(join(directory, "skills"));
  }
  for (const root of roots) paths.push(join(root, skill.name, "SKILL.md"));
  return [...new Set(paths.map((path) => resolve(path)))];
}

/** Resolve observed local installations for exact transcript-path attribution.
 * No skill contents are read. At most four filesystem lookups are active at once.
 */
export async function prepareUsagePaths(
  inventory: MachineInventory,
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
): Promise<KnownUsagePaths[]> {
  signal?.throwIfAborted();
  const entries: Array<{ skill: InventorySkill; cwd: string | undefined }> = [];
  for (const skill of inventory.globalSkills)
    if (skill.installed && skill.scope === "global")
      entries.push({ skill, cwd: undefined });
  for (const project of inventory.projects)
    for (const checkout of project.checkouts)
      for (const skill of checkout.skills ?? [])
        if (skill.installed && skill.scope === "project")
          entries.push({ skill, cwd: checkout.path });
  const aliases = new Map<string, Promise<string | undefined>>();
  const canonicalFiles = new Map<string, Promise<boolean>>();
  const inspect = (path: string): Promise<string | undefined> => {
    let pending = aliases.get(path);
    if (!pending) {
      pending = (async () => {
        signal?.throwIfAborted();
        try {
          const canonical = await realpath(path);
          signal?.throwIfAborted();
          let regular = canonicalFiles.get(canonical);
          if (!regular) {
            regular = stat(canonical).then(
              (info) => info.isFile(),
              () => false,
            );
            canonicalFiles.set(canonical, regular);
          }
          const valid = await regular;
          signal?.throwIfAborted();
          return valid ? canonical : undefined;
        } catch (error) {
          signal?.throwIfAborted();
          if ((error as NodeJS.ErrnoException).code) return undefined;
          throw error;
        }
      })();
      aliases.set(path, pending);
    }
    return pending;
  };
  const prepared = new Map<
    InventorySkill,
    {
      ids: Set<string>;
      paths: Set<string>;
      directories: Map<string, InstallationDirectory>;
    }
  >();
  let next = 0;
  const worker = async () => {
    while (next < entries.length) {
      signal?.throwIfAborted();
      const entry = entries[next++]!;
      const result = {
        ids: new Set<string>(),
        paths: new Set<string>(),
        directories: new Map<string, InstallationDirectory>(),
      };
      const paths = candidates(entry.skill, entry.cwd, env);
      const authoritative =
        entry.skill.path && paths[0] ? await inspect(paths[0]) : undefined;
      for (const path of paths) {
        const canonical = await inspect(path);
        if (!canonical || (entry.skill.path && canonical !== authoritative))
          continue;
        const directory = installationDirectory(dirname(path), entry.cwd, env);
        result.directories.set(JSON.stringify(directory), directory);
        result.ids.add(createHash("sha256").update(canonical).digest("hex"));
        result.paths.add(path);
        result.paths.add(canonical);
      }
      prepared.set(entry.skill, result);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(4, entries.length) }, worker),
  );
  signal?.throwIfAborted();
  const grouped = new Map<string, Set<string>>();
  for (const { skill } of entries) {
    const result = prepared.get(skill)!;
    skill.usagePathIds = [...result.ids].sort();
    skill.installationDirectories = [...result.directories.values()].sort(
      (a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)),
    );
    if (!result.paths.size) continue;
    const paths = grouped.get(skill.name) ?? new Set<string>();
    for (const path of result.paths) paths.add(path);
    grouped.set(skill.name, paths);
  }
  return [...grouped]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, paths]) => ({ name, paths: [...paths].sort() }));
}
