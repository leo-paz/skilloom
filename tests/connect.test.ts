import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { GitAdapter } from "../src/adapters/git.js";
import { initializeConfiguration } from "../src/cli/configuration.js";
import { connectConfiguration } from "../src/cli/connect.js";
import type { CliRuntime } from "../src/cli/runtime.js";
import {
  loadUserConfig,
  resolveConfigPaths,
  saveLocalMachine,
  saveManagedState,
  saveUserConfig,
} from "../src/core/config.js";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "skilloom-connect-"));
  const home = join(root, "home");
  const output: string[] = [];
  const runtime: CliRuntime = {
    cwd: root,
    env: { HOME: home, XDG_CONFIG_HOME: join(home, ".config") },
    isTTY: false,
    stdout: (line) => output.push(line),
    stderr: () => {},
    run: async () => {
      throw new Error("connect must not run the skills CLI");
    },
    confirm: async () => true,
  };
  const git = new GitAdapter();
  const remote = join(root, "remote.git");
  await git.initBare(remote);
  await initializeConfiguration([], runtime, true);
  const paths = resolveConfigPaths(runtime.env);
  const id = (await readFile(paths.machineIdPath, "utf8")).trim();
  const config = await loadUserConfig(paths.configPath);
  config.profiles.default!.skills.push({
    name: "review",
    source: "acme/skills",
    agents: ["codex"],
  });
  await saveUserConfig(paths.configPath, config);
  return { root, runtime, output, git, remote, paths, id, config };
}

it("connects existing local policy while preserving local identity and state", async () => {
  const f = await fixture();
  await saveLocalMachine(f.paths.machinePath, {
    id: f.id,
    name: "Laptop",
    workspaces: [{ path: join(f.root, "private-dev"), depth: 3 }],
  });
  await saveManagedState(f.paths.statePath, new Set(["existing-ownership"]));
  const originals = await Promise.all(
    [
      f.paths.configPath,
      f.paths.machineIdPath,
      f.paths.machinePath,
      f.paths.statePath,
    ].map((path) => readFile(path, "utf8")),
  );
  expect(await connectConfiguration([f.remote], f.runtime, true)).toBe(0);
  const result = JSON.parse(f.output.at(-1)!);
  expect(result).toMatchObject({
    ok: true,
    command: "connect",
    machineId: f.id,
  });
  expect(await readFile(result.backupPath, "utf8")).toBe(originals[0]);
  expect(
    await Promise.all(
      [
        f.paths.configPath,
        f.paths.machineIdPath,
        f.paths.machinePath,
        f.paths.statePath,
      ].map((path) => readFile(path, "utf8")),
    ),
  ).toEqual(originals);
  await f.git.clone(f.remote, join(f.root, "second-machine"));
  const shared = await loadUserConfig(
    join(f.root, "second-machine", "config.yaml"),
  );
  expect(shared.profiles).toEqual(f.config.profiles);
  expect(shared.machines[f.id]).toEqual({ profile: "default" });
  expect(shared.storage).toEqual({ mode: "managed", repository: f.remote });
  expect(resolveConfigPaths(f.runtime.env).configPath).toBe(result.configPath);
});

it("merges identical and disjoint shared entries but refuses conflicts without switching or publishing", async () => {
  const f = await fixture();
  const seed = join(f.root, "seed");
  await f.git.clone(f.remote, seed);
  const shared = structuredClone(f.config);
  shared.profiles.team = { skills: [] };
  shared.profiles.default!.skills[0]!.source = "other/skills";
  await saveUserConfig(join(seed, "config.yaml"), shared);
  await f.git.commitAndPush(seed, "Shared policy");
  const before = await readFile(f.paths.configPath, "utf8");
  await expect(
    connectConfiguration([f.remote], f.runtime, true),
  ).rejects.toThrow(/conflicting profiles entry default/);
  expect(existsSync(f.paths.locatorPath)).toBe(false);
  expect(await readFile(f.paths.configPath, "utf8")).toBe(before);
  await f.git.pull(seed);
  expect(await loadUserConfig(join(seed, "config.yaml"))).toEqual(shared);
  shared.profiles.default = f.config.profiles.default!;
  await saveUserConfig(join(seed, "config.yaml"), shared);
  await f.git.commitAndPush(seed, "Resolve shared policy");
  expect(await connectConfiguration([f.remote], f.runtime, true)).toBe(0);
  const merged = await loadUserConfig(
    resolveConfigPaths(f.runtime.env).configPath,
  );
  expect(Object.keys(merged.profiles).sort()).toEqual(["default", "team"]);
  expect(await connectConfiguration([f.remote], f.runtime, true)).toBe(0);
});

it("refuses to publish machine-local skill sources", async () => {
  const f = await fixture();
  f.config.profiles.default!.skills[0]!.source = join(f.root, "private-skill");
  await saveUserConfig(f.paths.configPath, f.config);
  await expect(
    connectConfiguration([f.remote], f.runtime, true),
  ).rejects.toThrow(/local source/);
  expect(existsSync(f.paths.locatorPath)).toBe(false);
  expect((await loadUserConfig(f.paths.configPath)).storage.mode).toBe("local");
});

it("connects a fresh second machine to the shared profile", async () => {
  const f = await fixture();
  await connectConfiguration([f.remote], f.runtime, true);
  const home = join(f.root, "second-home");
  const runtime = {
    ...f.runtime,
    env: { HOME: home, XDG_CONFIG_HOME: join(home, ".config") },
  };
  expect(await connectConfiguration([f.remote], runtime, true)).toBe(0);
  const paths = resolveConfigPaths(runtime.env);
  const config = await loadUserConfig(paths.configPath);
  const id = (await readFile(paths.machineIdPath, "utf8")).trim();
  expect(id).not.toBe(f.id);
  expect(config.machines[id]).toEqual({ profile: "default" });
  expect(config.profiles).toEqual(f.config.profiles);
  expect(paths.configPath).toBe(
    join(paths.appDir, "repository", "config.yaml"),
  );
});

it("keeps the local configuration active when the remote rejects publication", async () => {
  const f = await fixture();
  await writeFile(
    join(f.remote, "hooks", "pre-receive"),
    "#!/bin/sh\nexit 1\n",
    { mode: 0o700 },
  );
  const before = await readFile(f.paths.configPath, "utf8");
  await expect(
    connectConfiguration([f.remote], f.runtime, true),
  ).rejects.toThrow(/push/);
  expect(resolveConfigPaths(f.runtime.env).configPath).toBe(f.paths.configPath);
  expect(await readFile(f.paths.configPath, "utf8")).toBe(before);
  expect(existsSync(join(f.paths.appDir, "repository"))).toBe(false);
});
