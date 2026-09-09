import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { GitAdapter } from "../src/adapters/git.js";
import {
  configureProfiles,
  initializeConfiguration,
} from "../src/cli/configuration.js";
import { migrateConfiguration, previewMigration } from "../src/cli/migrate.js";
import type { CliRuntime } from "../src/cli/runtime.js";
import { setupMachine } from "../src/cli/setup.js";
import {
  loadMachineId,
  loadUserConfig,
  resolveConfigPaths,
  saveLocalMachine,
  saveManagedState,
  saveUserConfig,
} from "../src/core/config.js";
import { managedStateKey } from "../src/core/plan.js";

async function fixture() {
  const home = await realpath(
    await mkdtemp(join(tmpdir(), "skilloom-migration-test-")),
  );
  const out: string[] = [];
  const runtime: CliRuntime = {
    cwd: home,
    env: {
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      CODEX_HOME: join(home, ".codex"),
    },
    isTTY: false,
    stdout: (line) => out.push(line),
    stderr: () => {},
    confirm: async () => true,
    run: async (_executable, args) => ({
      code: 0,
      stdout: args.includes("list") ? "[]" : "",
      stderr: "",
    }),
  };
  await initializeConfiguration([], runtime, true);
  return { home, runtime, out, paths: resolveConfigPaths(runtime.env) };
}
describe("migration and profile commands", () => {
  it("does not connect a new machine when the preserved profile collides", async () => {
    const shared = await fixture();
    const before = await readFile(shared.paths.configPath, "utf8");
    const home = await realpath(
      await mkdtemp(join(tmpdir(), "skilloom-profile-collision-")),
    );
    const joining: CliRuntime = {
      ...shared.runtime,
      cwd: home,
      env: { HOME: home, XDG_CONFIG_HOME: join(home, ".config") },
    };
    await expect(
      setupMachine(
        [
          "--storage",
          "external",
          "--path",
          shared.paths.configPath,
          "--preserve-global-profile",
          "default",
        ],
        joining,
        true,
      ),
    ).rejects.toThrow("already exists");
    expect(await readFile(shared.paths.configPath, "utf8")).toBe(before);
    expect(existsSync(resolveConfigPaths(joining.env).locatorPath)).toBe(false);
    expect(existsSync(resolveConfigPaths(joining.env).configPath)).toBe(false);
  });
  it("joins existing external configuration with an isolated global profile on first setup", async () => {
    const shared = await fixture();
    const config = await loadUserConfig(shared.paths.configPath);
    config.profiles.default!.skills = [
      { name: "shared", source: "acme/shared", agents: ["codex"] },
    ];
    await saveUserConfig(shared.paths.configPath, config);
    const home = await realpath(
      await mkdtemp(join(tmpdir(), "skilloom-profile-join-")),
    );
    const joining: CliRuntime = {
      ...shared.runtime,
      cwd: home,
      env: {
        HOME: home,
        XDG_CONFIG_HOME: join(home, ".config"),
        CODEX_HOME: join(home, ".codex"),
      },
    };
    await setupMachine(
      [
        "--storage",
        "external",
        "--path",
        shared.paths.configPath,
        "--preserve-global-profile",
        "joining",
        "--machine-name",
        "Joining",
      ],
      joining,
      true,
    );
    const joined = await loadUserConfig(shared.paths.configPath);
    expect(joined.profiles.default).toEqual(config.profiles.default);
    expect(joined.profiles.joining?.skills).toEqual([]);
    const id = await loadMachineId(
      resolveConfigPaths(joining.env).machineIdPath,
    );
    expect(joined.machines[id]).toEqual({
      profile: "joining",
      name: "Joining",
    });
  });

  it("previews read-only, backs up exact bytes, preserves comments and skills, and rejects stale preview", async () => {
    const f = await fixture();
    const project = join(f.home, "repo");
    await mkdir(join(project, ".agents", "skills", "review"), {
      recursive: true,
    });
    execFileSync("git", ["init", "-q", project]);
    const skillFile = join(project, ".agents", "skills", "review", "SKILL.md");
    await writeFile(
      skillFile,
      "---\nname: review\ndescription: Review\n---\nKeep my edit\n",
    );
    execFileSync("git", ["-C", project, "add", "."]);
    const id = await loadMachineId(f.paths.machineIdPath);
    await saveLocalMachine(f.paths.machinePath, {
      id,
      name: "Local",
      workspaces: [{ path: project, depth: 1 }],
    });
    f.runtime.run = async (executable, args) => ({
      code: 0,
      stderr: "",
      stdout:
        executable === "git"
          ? "git@github.com:acme/repo.git"
          : args.includes("--global")
            ? "[]"
            : JSON.stringify([
                {
                  scope: "project",
                  name: "review",
                  source: "acme/skills",
                  agents: ["codex"],
                  path: join(project, ".agents", "skills", "review"),
                },
              ]),
    });
    const config = await loadUserConfig(f.paths.configPath);
    config.projects["github.com/acme/repo"] = {
      skills: [{ name: "review", source: "acme/skills", agents: ["codex"] }],
    };
    await saveUserConfig(f.paths.configPath, config);
    await writeFile(
      f.paths.configPath,
      `# preserve me\n${await readFile(f.paths.configPath, "utf8")}`,
    );
    await saveManagedState(
      f.paths.statePath,
      new Set([
        managedStateKey(
          { name: "review", scope: "project", source: "acme/skills" },
          project,
        ),
      ]),
    );
    const before = await readFile(f.paths.configPath, "utf8"),
      state = await readFile(f.paths.statePath, "utf8");
    await migrateConfiguration(["--dry-run"], f.runtime, true);
    expect(await readFile(f.paths.configPath, "utf8")).toBe(before);
    expect(await readFile(f.paths.statePath, "utf8")).toBe(state);
    const preview = await previewMigration(f.runtime);
    expect(preview.preview.requirements).toHaveLength(1);
    await expect(
      migrateConfiguration(["--yes", "--expect", "stale"], f.runtime, true),
    ).rejects.toThrow("changed");
    await migrateConfiguration(
      ["--yes", "--expect", preview.preview.fingerprint],
      f.runtime,
      true,
    );
    const result = JSON.parse(f.out.at(-1)!);
    expect(await readFile(join(result.backupPath, "config.yaml"), "utf8")).toBe(
      before,
    );
    expect(await readFile(join(result.backupPath, "state.json"), "utf8")).toBe(
      state,
    );
    expect(await readFile(f.paths.configPath, "utf8")).toContain(
      "# preserve me",
    );
    expect(
      (await loadUserConfig(f.paths.configPath)).projects[
        "github.com/acme/repo"
      ]?.skills,
    ).toEqual([]);
    expect(await readFile(skillFile, "utf8")).toContain("Keep my edit");
    // A rejected publication must report local completion and retain recoverable backups.
    config.storage = {
      mode: "managed",
      repository: "https://example.invalid/config.git",
    };
    await saveUserConfig(f.paths.configPath, config);
    await writeFile(f.paths.statePath, state);
    const beforeManaged = await readFile(f.paths.configPath, "utf8");
    const status = vi
      .spyOn(GitAdapter.prototype, "status")
      .mockResolvedValue(" M config.yaml");
    const publish = vi
      .spyOn(GitAdapter.prototype, "commitAndPush")
      .mockRejectedValue(new Error("push rejected: fetch first"));
    try {
      await expect(
        migrateConfiguration(["--yes"], f.runtime, true),
      ).rejects.toThrow("uncommitted changes");
      expect(await readFile(f.paths.configPath, "utf8")).toBe(beforeManaged);
      expect(await readFile(f.paths.statePath, "utf8")).toBe(state);
      status.mockResolvedValue("");
      await expect(
        migrateConfiguration(["--yes"], f.runtime, true),
      ).rejects.toThrow("Migration applied locally; publication failed");
      expect(
        (await loadUserConfig(f.paths.configPath)).projects[
          "github.com/acme/repo"
        ]?.skills,
      ).toEqual([]);
      expect(await readFile(skillFile, "utf8")).toContain("Keep my edit");
      expect(publish).toHaveBeenCalledTimes(1);
    } finally {
      status.mockRestore();
      publish.mockRestore();
    }
  });
  it("creates a personal global profile without changing shared profile requirements and refuses collisions", async () => {
    const f = await fixture();
    const config = await loadUserConfig(f.paths.configPath);
    config.profiles.default!.skills = [
      { name: "shared", source: "acme/shared", agents: ["codex"] },
    ];
    await saveUserConfig(f.paths.configPath, config);
    await setupMachine(
      ["--preserve-global-profile", "laptop", "--machine-name", "Laptop"],
      f.runtime,
      true,
    );
    const after = await loadUserConfig(f.paths.configPath);
    expect(after.profiles.default).toEqual(config.profiles.default);
    expect(after.profiles.laptop?.skills).toEqual([]);
    expect(Object.values(after.machines)[0]).toEqual({
      name: "Laptop",
      profile: "laptop",
    });
    await expect(
      setupMachine(["--preserve-global-profile", "default"], f.runtime, true),
    ).rejects.toThrow("already exists");
    await configureProfiles(
      [
        "--add-profile",
        "copy",
        "--copy-profile",
        "default",
        "--profile",
        "copy",
      ],
      f.runtime,
      true,
    );
    const copied = await loadUserConfig(f.paths.configPath);
    expect(copied.profiles.copy).toEqual(config.profiles.default);
    expect(Object.values(copied.machines)[0]?.name).toBe("Laptop");
  });
});
