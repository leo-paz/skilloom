import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import { parse } from "yaml";
import { z } from "zod";
import { resolveConfigPaths } from "./config.js";
import type { InstalledSkill } from "./types.js";

const exec = promisify(execFile);
const proofSchema = z.object({
  name: z.string(),
  scope: z.enum(["global", "project"]),
  path: z.string(),
  resolvedPath: z.string(),
  source: z.string(),
  hash: z.string().regex(/^[a-f0-9]{64}$/),
  commit: z.string().regex(/^[a-f0-9]{40,64}$/),
});
type Proof = z.infer<typeof proofSchema>;
const storeSchema = z.object({
  version: z.literal(1),
  proofs: z.array(proofSchema),
});

async function loadProofs(env: NodeJS.ProcessEnv): Promise<Proof[]> {
  try {
    return storeSchema.parse(
      JSON.parse(
        await readFile(
          join(resolveConfigPaths(env).appDir, "provenance.json"),
          "utf8",
        ),
      ),
    ).proofs;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new Error(
      "Local provenance file is invalid; inspect provenance.json before verifying sources",
      { cause: error },
    );
  }
}

/** Hash names and bytes; reject links and special files rather than escaping the skill tree. */
async function treeHash(root: string): Promise<string> {
  const hash = createHash("sha256");
  let count = 0;
  let bytes = 0;
  const visit = async (directory: string, prefix: string): Promise<void> => {
    for (const name of (await readdir(directory)).sort()) {
      if (name === ".git") continue;
      const path = join(directory, name);
      const relative = `${prefix}${name}`;
      const info = await lstat(path);
      if (info.isSymbolicLink())
        throw new Error(
          `Cannot verify symbolic link inside skill: ${relative}`,
        );
      if (++count > 20000)
        throw new Error("Skill tree exceeds verification file limit");
      if (info.isDirectory()) await visit(path, `${relative}/`);
      else if (info.isFile()) {
        bytes += info.size;
        if (bytes > 100 * 1024 * 1024)
          throw new Error("Skill tree exceeds verification size limit");
        hash.update(`${Buffer.byteLength(relative)}:${relative}:${info.size}:`);
        hash.update(await readFile(path));
      } else
        throw new Error(`Cannot verify special file inside skill: ${relative}`);
    }
  };
  if (!(await lstat(join(root, "SKILL.md"))).isFile())
    throw new Error("Installed skill requires a regular SKILL.md");
  await visit(root, "");
  return hash.digest("hex");
}

async function sourceRepository(source: string, cwd: string): Promise<string> {
  if (
    source.startsWith("/") ||
    source.startsWith("./") ||
    source.startsWith("../")
  ) {
    const path = resolve(cwd, source);
    if (!(await lstat(path)).isDirectory())
      throw new Error("Local source must be a Git repository directory");
    return path;
  }
  if (/^[\w.-]+\/[\w.-]+$/.test(source))
    return `https://github.com/${source}.git`;
  if (/^git@[\w.-]+:[\w./-]+(?:\.git)?$/.test(source)) return source;
  try {
    const url = new URL(source);
    if (
      !["https:", "ssh:"].includes(url.protocol) ||
      url.password ||
      (url.protocol === "https:" && url.username) ||
      url.search ||
      url.hash
    )
      throw new Error();
    return source;
  } catch {
    throw new Error(
      "Source must be owner/repo, a credential-free HTTPS/SSH Git URL, or a local Git repository directory",
    );
  }
}

async function findSkill(root: string, name: string): Promise<string> {
  const candidates: string[] = [];
  let visited = 0;
  const walk = async (directory: string, depth: number): Promise<void> => {
    if (depth > 8 || ++visited > 10000)
      throw new Error("Source exceeds skill discovery limits");
    const entries = await readdir(directory, { withFileTypes: true });
    const skill = entries.find(
      (entry) => entry.name === "SKILL.md" && entry.isFile(),
    );
    if (skill) {
      const content = await readFile(join(directory, "SKILL.md"), "utf8");
      const frontmatter = content.match(
        /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/,
      )?.[1];
      const declared = frontmatter
        ? (parse(frontmatter) as { name?: unknown } | null)?.name
        : undefined;
      if (declared === name || (!declared && basename(directory) === name))
        candidates.push(directory);
      return;
    }
    for (const entry of entries)
      if (entry.isDirectory() && entry.name !== ".git")
        await walk(join(directory, entry.name), depth + 1);
  };
  await walk(root, 0);
  if (candidates.length !== 1)
    throw new Error(
      `Source must contain exactly one skill named ${name}; found ${candidates.length}`,
    );
  return candidates[0]!;
}

export async function verifyProvenance(
  skill: InstalledSkill,
  source: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  options: { persist: boolean },
): Promise<Proof & { verified: true; persisted: boolean }> {
  if (!skill.path) throw new Error("Installed skill has no path to verify");
  const repository = await sourceRepository(source, cwd);
  if (repository.startsWith("/")) source = repository;
  if (skill.source && skill.source !== source)
    throw new Error(
      `Installed skill already has a different source: ${skill.source}`,
    );
  const path = resolve(cwd, skill.path);
  const resolvedPath = await realpath(path);
  const hash = await treeHash(resolvedPath);
  const temporary = await mkdtemp(join(tmpdir(), "skilloom-source-"));
  try {
    const checkout = join(temporary, "repository");
    await exec(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "clone",
        "--depth",
        "1",
        "--no-local",
        "--",
        repository,
        checkout,
      ],
      { timeout: 120000, maxBuffer: 1024 * 1024 },
    );
    const candidate = await findSkill(checkout, skill.name);
    if ((await treeHash(candidate)) !== hash)
      throw new Error(
        "Installed skill content does not match the requested source; no provenance was saved",
      );
    const commit = (
      await exec("git", ["rev-parse", "HEAD"], { cwd: checkout })
    ).stdout.trim();
    if (
      (await realpath(path)) !== resolvedPath ||
      (await treeHash(resolvedPath)) !== hash
    )
      throw new Error(
        "Installed skill changed during verification; retry verification",
      );
    const proof: Proof = {
      name: skill.name,
      scope: skill.scope,
      path,
      resolvedPath,
      source,
      hash,
      commit,
    };
    if (options.persist) {
      const appDir = resolveConfigPaths(env).appDir;
      await mkdir(appDir, { recursive: true });
      const lock = join(appDir, "provenance.lock");
      try {
        await mkdir(lock);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST")
          throw new Error(
            "Another source verification is saving provenance; retry when it finishes (inspect provenance.lock if interrupted)",
          );
        throw error;
      }
      try {
        const proofs = await loadProofs(env);
        const previous = proofs.find(
          (item) =>
            item.path === path &&
            item.scope === skill.scope &&
            item.name === skill.name,
        );
        if (previous && previous.source !== source)
          throw new Error(
            `Existing verified source conflicts: ${previous.source}`,
          );
        const target = join(appDir, "provenance.json");
        const pending = `${target}.${randomUUID()}.tmp`;
        await writeFile(
          pending,
          `${JSON.stringify({ version: 1, proofs: [...proofs.filter((item) => item !== previous), proof] }, null, 2)}\n`,
          { mode: 0o600 },
        );
        await rename(pending, target);
      } finally {
        await rm(lock, { recursive: true });
      }
    }
    return { ...proof, verified: true, persisted: options.persist };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function applyProvenance(
  skills: InstalledSkill[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<InstalledSkill[]> {
  const proofs = await loadProofs(env);
  return Promise.all(
    skills.map(async (skill) => {
      if (skill.source || !skill.path) return skill;
      const proof = proofs.find(
        (item) =>
          item.name === skill.name &&
          item.scope === skill.scope &&
          item.path === resolve(cwd, skill.path!),
      );
      if (!proof) return skill;
      try {
        if (
          (await realpath(proof.path)) === proof.resolvedPath &&
          (await treeHash(proof.resolvedPath)) === proof.hash
        )
          return { ...skill, source: proof.source };
      } catch {
        /* A missing or unsafe installation invalidates the saved proof. */
      }
      return skill;
    }),
  );
}
