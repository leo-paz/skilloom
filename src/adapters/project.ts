import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { InstalledSkill, PlanOperation } from "../core/types.js";

const execute = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    return (
      await execute("git", ["-C", cwd, ...args], {
        maxBuffer: 16 * 1024 * 1024,
      })
    ).stdout;
  } catch {
    return null;
  }
}

export async function isLinkedWorktree(cwd: string): Promise<boolean> {
  const dirs = await git(cwd, [
    "rev-parse",
    "--path-format=absolute",
    "--git-dir",
    "--git-common-dir",
  ]);
  if (!dirs) return false;
  const [directory, common] = dirs.trim().split("\n");
  return Boolean(directory && common && directory !== common);
}

/** Git owns tracked skill contents and tracked links, regardless of old managed state. */
export async function inspectProjectSkills(
  cwd: string,
  installed: InstalledSkill[],
): Promise<InstalledSkill[]> {
  const tracked = await git(cwd, ["ls-files", "-z"]);
  if (tracked === null && (await git(cwd, ["rev-parse", "--git-dir"]))) {
    throw new Error(
      `Cannot inspect tracked skills in ${cwd}; refusing to plan project changes.`,
    );
  }
  const files = tracked?.split("\0").filter(Boolean) ?? [];
  const root = await realpath(cwd);
  return Promise.all(
    installed.map(async (skill) => {
      const candidates = files.filter((file) =>
        file
          .split("/")
          .some(
            (part, index, parts) =>
              part === "skills" && parts[index + 1] === skill.name,
          ),
      );
      if (skill.path) {
        const path = resolve(cwd, skill.path);
        const canonical = await realpath(path).catch(() => path);
        for (const candidate of [path, canonical]) {
          const rel = relative(root, candidate);
          if (!isAbsolute(rel) && rel !== ".." && !rel.startsWith("../")) {
            candidates.push(
              ...files.filter(
                (file) => file === rel || file.startsWith(`${rel}/`),
              ),
            );
          }
        }
      }
      return { ...skill, repositoryOwned: candidates.length > 0 };
    }),
  );
}

export function protectRepositorySkills(
  operations: PlanOperation[],
  installed: InstalledSkill[],
): PlanOperation[] {
  const owned = new Set(
    installed
      .filter((skill) => skill.repositoryOwned)
      .map((skill) => skill.name),
  );
  return operations.filter(
    (operation) =>
      operation.skill.scope !== "project" || !owned.has(operation.skill.name),
  );
}
