import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseDocument } from "yaml";
import { GitAdapter } from "../adapters/git.js";
import { SkillsAdapter } from "../adapters/skills.js";
import {
  loadLocalMachine,
  loadManagedState,
  loadUserConfig,
  resolveConfigPaths,
  saveManagedState,
} from "../core/config.js";
import { buildInventory } from "../core/inventory.js";
import { buildMigrationPreview } from "../core/migration.js";
import {
  applyOwnershipReleaseDelta,
  releaseOwnership,
} from "../core/ownership-release.js";
import type { CliRuntime } from "./runtime.js";

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.migration-tmp`;
  await writeFile(temporary, content, { mode: 0o600 });
  await rename(temporary, path);
}
function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const value = args[i + 1];
  if (!value || value.startsWith("--"))
    throw new Error(`${name} requires a value`);
  return value;
}
export async function previewMigration(
  runtime: CliRuntime,
  explicitConfigPath?: string,
) {
  const paths = resolveConfigPaths(runtime.env, explicitConfigPath);
  const config = await loadUserConfig(paths.configPath);
  const managed = await loadManagedState(paths.statePath);
  const machine = await loadLocalMachine(paths.machinePath);
  const adapter = new SkillsAdapter(runtime.run);
  const inventory = await buildInventory(
    { machine, config, managed, cwd: runtime.cwd, env: runtime.env },
    {
      ...(runtime.onProgress ? { onProgress: runtime.onProgress } : {}),
      listSkills: (scope, cwd, env) => adapter.list(scope, cwd, env),
      projectRemote: async (cwd) => {
        const result = await runtime.run(
          "git",
          ["config", "--get", "remote.origin.url"],
          { cwd, env: runtime.env },
        );
        return result.code === 0 && result.stdout.trim()
          ? result.stdout.trim()
          : null;
      },
    },
  );
  applyOwnershipReleaseDelta(managed, inventory.ownershipRelease);
  const raw = await readFile(paths.configPath, "utf8");
  const stateRaw = existsSync(paths.statePath)
    ? await readFile(paths.statePath, "utf8")
    : null;
  const preview = buildMigrationPreview(config, managed, inventory);
  preview.fingerprint = createHash("sha256")
    .update(preview.fingerprint)
    .update(raw)
    .update(stateRaw ?? "")
    .digest("hex");
  return { paths, config, managed, inventory, raw, stateRaw, preview };
}
export async function migrateConfiguration(
  args: string[],
  runtime: CliRuntime,
  json: boolean,
): Promise<number> {
  const explicit = option(args, "--config");
  const initial = await previewMigration(runtime, explicit);
  const { preview } = initial;
  const dryRun = args.includes("--dry-run");
  if (!dryRun && !args.includes("--yes"))
    throw new Error(
      "migration requires --dry-run to preview or --yes to apply",
    );
  const expected = option(args, "--expect");
  if (expected && expected !== preview.fingerprint)
    throw new Error(
      "Migration preview changed; inspect a fresh --dry-run before applying.",
    );
  let backupPath: string | undefined;
  if (!dryRun) {
    if (preview.blockers.length) throw new Error(preview.blockers.join(" "));
    if (preview.requirements.length || preview.stateKeys.length) {
      if (
        initial.config.storage.mode === "managed" &&
        (
          await new GitAdapter().status(dirname(initial.paths.configPath))
        ).trim()
      )
        throw new Error(
          "Managed configuration has uncommitted changes; preserve and resolve them before applying migration.",
        );
      const refreshed = await previewMigration(runtime, explicit);
      if (refreshed.preview.fingerprint !== preview.fingerprint)
        throw new Error(
          "Migration inputs changed during review; run --dry-run again.",
        );
      backupPath = join(
        initial.paths.appDir,
        "backups",
        `migration-${Date.now()}-${preview.fingerprint.slice(0, 12)}`,
      );
      await mkdir(backupPath, { recursive: true });
      await copyFile(initial.paths.configPath, join(backupPath, "config.yaml"));
      if (initial.stateRaw !== null)
        await copyFile(initial.paths.statePath, join(backupPath, "state.json"));
      const doc = parseDocument(initial.raw);
      if (preview.requirements.length) {
        const releases = preview.requirements.map((removal) => ({
          id: createHash("sha256")
            .update(
              `${preview.fingerprint}:${removal.projectId}:${removal.skill.name}`,
            )
            .digest("hex"),
          projectId: removal.projectId,
          name: removal.skill.name,
        }));
        initial.config.version = 2;
        initial.config.ownershipReleases = [
          ...(initial.config.ownershipReleases ?? []),
          ...releases,
        ];
        doc.set("version", 2);
        doc.set("ownershipReleases", initial.config.ownershipReleases);
        const released = releaseOwnership(
          initial.config.ownershipReleases,
          initial.managed,
          initial.inventory.projects.flatMap((project) =>
            project.checkouts.map((checkout) => ({
              projectId: project.id,
              path: checkout.path,
            })),
          ),
        );
        initial.managed = released.managed;
      }
      for (const removal of preview.requirements) {
        const policy = initial.config.projects[removal.projectId]!;
        const index = policy.skills.findIndex(
          (skill) => skill.name === removal.skill.name,
        );
        if (index < 0) throw new Error("Migration policy changed unexpectedly");
        doc.deleteIn(["projects", removal.projectId, "skills", index]);
        policy.skills.splice(index, 1);
      }
      for (const key of preview.stateKeys) initial.managed.delete(key);
      // Release ownership first so an interrupted migration cannot remove an installation.
      try {
        await saveManagedState(initial.paths.statePath, initial.managed);
        if (preview.requirements.length)
          await atomicWrite(initial.paths.configPath, doc.toString());
      } catch (error) {
        await atomicWrite(initial.paths.configPath, initial.raw);
        if (initial.stateRaw !== null)
          await atomicWrite(initial.paths.statePath, initial.stateRaw);
        else await rm(initial.paths.statePath, { force: true });
        throw error;
      }
      if (
        initial.config.storage.mode === "managed" &&
        preview.requirements.length
      ) {
        try {
          await new GitAdapter().commitAndPush(
            dirname(initial.paths.configPath),
            "Migrate obsolete personal skill ownership",
          );
        } catch (error) {
          throw new Error(
            `Migration applied locally; publication failed. Backup: ${backupPath}. Resolve managed Git state and push before sync. ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
    }
  }
  runtime.stdout(
    json
      ? JSON.stringify({
          ok: true,
          command: "migrate",
          dryRun,
          applied: !dryRun,
          preview,
          backupPath,
        })
      : `${dryRun ? "Preview" : "Migrated"}: ${preview.requirements.length} obsolete personal requirement(s), ${preview.stateKeys.length} ownership record(s).${backupPath ? ` Backup: ${backupPath}` : ""}${preview.blockers.length ? ` Blocked: ${preview.blockers.join(" ")}` : ""}`,
  );
  return preview.blockers.length ? 1 : 0;
}
