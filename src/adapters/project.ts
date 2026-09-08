import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import type { InstalledSkill, PlanOperation } from "../core/types.js";

const execute = promisify(execFile);
const installationRoots = new Set([
  ".agents",
  ".agent",
  ".claude",
  ".codex",
  ".cursor",
  ".github",
  ".opencode",
  ".windsurf",
  ".cline",
  ".roo",
  ".gemini",
  ".goose",
  ".kiro",
  ".trae",
  ".augment",
  ".continue",
]);

function installationName(
  file: string,
  links: Set<string>,
): string | undefined {
  const [root, directory, name, ...rest] = file.split("/");
  return root &&
    installationRoots.has(root) &&
    directory === "skills" &&
    name &&
    (rest.length > 0 || links.has(file))
    ? name
    : undefined;
}

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
  if (!dirs)
    throw new Error(
      `Cannot inspect Git checkout ${cwd}; refusing to discover it.`,
    );
  const [directory, common] = dirs.trim().split("\n");
  return Boolean(directory && common && directory !== common);
}

/** Git owns tracked skill contents and tracked links, regardless of old managed state. */
export async function inspectProjectSkills(
  cwd: string,
  installed: InstalledSkill[],
): Promise<InstalledSkill[]> {
  const tracked = await git(cwd, ["ls-files", "--stage", "-z"]);
  if (tracked === null && existsSync(resolve(cwd, ".git"))) {
    throw new Error(
      `Cannot inspect tracked skills in ${cwd}; refusing to plan project changes.`,
    );
  }
  const records = tracked?.split("\0").filter(Boolean) ?? [];
  const files = records.map((record) => record.slice(record.indexOf("\t") + 1));
  const links = new Set(
    records
      .filter((record) => record.startsWith("120000 "))
      .map((record) => record.slice(record.indexOf("\t") + 1)),
  );
  const root = await realpath(cwd);
  const inspected = await Promise.all(
    installed.map(async (skill) => {
      const candidates = files.filter(
        (file) => installationName(file, links) === skill.name,
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
  for (const file of files) {
    const name = installationName(file, links);
    if (!name || inspected.some((skill) => skill.name === name)) continue;
    inspected.push({
      name,
      scope: "project",
      source: null,
      agents: [],
      repositoryOwned: true,
      missing: true,
    });
  }
  return inspected;
}

export async function projectRevision(
  cwd: string,
): Promise<{ branch?: string | undefined; commit?: string | undefined }> {
  const [branch, commit] = await Promise.all([
    git(cwd, ["symbolic-ref", "--short", "-q", "HEAD"]),
    git(cwd, ["rev-parse", "--verify", "HEAD"]),
  ]);
  return {
    ...(branch ? { branch: branch.trim() } : {}),
    ...(commit ? { commit: commit.trim() } : {}),
  };
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
