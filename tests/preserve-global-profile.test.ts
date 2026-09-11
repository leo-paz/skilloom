import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { GitAdapter } from "../src/adapters/git.js";
import { initializeConfiguration } from "../src/cli/configuration.js";
import type { CliRuntime } from "../src/cli/runtime.js";
import { setupMachine } from "../src/cli/setup.js";
import {
  loadManagedState,
  loadUserConfig,
  resolveConfigPaths,
  saveManagedState,
  saveUserConfig,
} from "../src/core/config.js";

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "skilloom-preserve-global-"));
  const output: string[] = [];
  const entries = [
    { name: "unknown", source: null, agents: ["codex"] },
    { name: "local", source: join(home, "local-source"), agents: ["codex"] },
    { name: "uncovered", source: "acme/skills", agents: [] },
  ].map((skill) => ({
    ...skill,
    scope: "global",
    path: join(home, ".claude", "skills", skill.name),
  }));
  for (const skill of entries) {
    await mkdir(skill.path, { recursive: true });
    await writeFile(join(skill.path, "SKILL.md"), `Preserve ${skill.name}\n`);
  }
  const runtime: CliRuntime = {
    cwd: home,
    env: {
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      CODEX_HOME: join(home, ".codex"),
    },
    isTTY: false,
    stdout: (line) => output.push(line),
    stderr: () => {},
    confirm: async () => false,
    run: async (_executable, args) => ({
      code: 0,
      stderr: "",
      stdout: args.includes("list") ? JSON.stringify(entries) : "",
    }),
  };
  await initializeConfiguration([], runtime, true);
  const paths = resolveConfigPaths(runtime.env);
  const keys = entries.map((skill) => `global:${skill.name}`);
  await saveManagedState(paths.statePath, new Set(keys));
  return { home, runtime, output, entries, keys, paths };
}
describe("preserving previously owned global installations", () => {
  it("releases skipped unknown, nonportable, and uncovered global ownership without removing installed files", async () => {
    const f = await fixture();
    const config = await loadUserConfig(f.paths.configPath);
    config.storage = {
      mode: "managed",
      repository: "https://example.invalid/skills-config.git",
    };
    await saveUserConfig(f.paths.configPath, config);
    const pull = vi.spyOn(GitAdapter.prototype, "pull").mockResolvedValue();
    const push = vi
      .spyOn(GitAdapter.prototype, "commitAndPush")
      .mockResolvedValue();
    try {
      await setupMachine(
        [
          "--preserve-global-profile",
          "machine-personal",
          "--machine-name",
          "Preserved",
        ],
        f.runtime,
        true,
      );
      const state = await loadManagedState(f.paths.statePath);
      for (const key of f.keys) expect(state.has(key)).toBe(false);
      const result = JSON.parse(f.output.at(-1)!);
      expect(
        result.inventory.operations.filter(
          (operation: { kind: string }) => operation.kind === "remove",
        ),
      ).toEqual([]);
      expect(result.adoption.unmanaged).toBe(3);
      for (const skill of f.entries)
        expect(await readFile(join(skill.path, "SKILL.md"), "utf8")).toBe(
          `Preserve ${skill.name}\n`,
        );
      expect(
        (await loadUserConfig(f.paths.configPath)).profiles["machine-personal"]
          ?.skills,
      ).toEqual([]);
    } finally {
      pull.mockRestore();
      push.mockRestore();
    }
  });
  it("keeps existing ownership for ordinary --no-adopt setup", async () => {
    const f = await fixture();
    await setupMachine(
      ["--no-adopt", "--machine-name", "Existing"],
      f.runtime,
      true,
    );
    const state = await loadManagedState(f.paths.statePath);
    for (const key of f.keys) expect(state.has(key)).toBe(true);
  });
});
