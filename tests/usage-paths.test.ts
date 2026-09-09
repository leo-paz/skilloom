import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { InventorySkill, MachineInventory } from "../src/core/types.js";
import { prepareUsagePaths } from "../src/core/usage-paths.js";

const installed = (name = "review"): InventorySkill => ({
  name,
  scope: "project",
  source: null,
  agents: ["codex"],
  installed: true,
  desired: false,
  managed: false,
  reasons: [],
});
async function fixture() {
  const home = await realpath(
    await mkdtemp(join(tmpdir(), "skilloom-usage-paths-")),
  );
  const first = join(home, "first"),
    second = join(home, "second");
  const a = installed(),
    b = installed();
  const inventory = {
    globalSkills: [],
    projects: [
      {
        id: "repo",
        skills: [],
        checkouts: [
          { path: first, skills: [a] },
          { path: second, skills: [b] },
        ],
      },
    ],
    remoteObservations: [
      {
        machine: { id: "remote", name: "Remote" },
        observedAt: "",
        projects: [{ id: "repo", name: "Repo", skills: [installed()] }],
      },
    ],
  } as unknown as MachineInventory;
  const file = async (root: string) => {
    const path = join(root, ".agents", "skills", "review", "SKILL.md");
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, "No need to read content");
    return path;
  };
  return { home, first, second, a, b, inventory, file, env: { HOME: home } };
}
describe("local usage path attribution", () => {
  it("distinguishes same-name independent checkouts and never mutates remote or aggregate skills", async () => {
    const f = await fixture();
    const first = await f.file(f.first),
      second = await f.file(f.second);
    const remote = JSON.stringify(f.inventory.remoteObservations);
    const aggregate = installed();
    f.inventory.projects[0]!.skills = [aggregate];
    const result = await prepareUsagePaths(f.inventory, f.env);
    expect(result).toEqual([{ name: "review", paths: [first, second].sort() }]);
    expect(f.a.usagePathIds).toEqual([
      createHash("sha256").update(first).digest("hex"),
    ]);
    expect(f.b.usagePathIds).toEqual([
      createHash("sha256").update(second).digest("hex"),
    ]);
    expect(f.a.usagePathIds).not.toEqual(f.b.usagePathIds);
    expect(aggregate.usagePathIds).toBeUndefined();
    expect(JSON.stringify(f.inventory.remoteObservations)).toBe(remote);
  });
  it("deduplicates symlink aliases to one ID while returning aliases and canonical evidence paths", async () => {
    const f = await fixture();
    const canonical = await f.file(f.first);
    const alias = join(f.first, ".claude", "skills", "review");
    await mkdir(join(alias, ".."), { recursive: true });
    await symlink(join(canonical, ".."), alias);
    const result = await prepareUsagePaths(f.inventory, f.env);
    expect(f.a.usagePathIds).toHaveLength(1);
    expect(result[0]?.paths).toEqual(
      [canonical, join(alias, "SKILL.md")].sort(),
    );
    expect(f.b.usagePathIds).toEqual([]);
  });
  it("respects global override directories and explicit installed plugin paths", async () => {
    const f = await fixture();
    const override = join(f.home, "custom-codex");
    const root = join(override, "skills", "global");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "SKILL.md"), "global");
    const global = { ...installed("global"), scope: "global" as const };
    const plugin = join(f.home, "plugin-cache", "nested");
    await mkdir(plugin, { recursive: true });
    await writeFile(join(plugin, "SKILL.md"), "explicit installed source");
    await f.file(f.first); // Unrelated same-name fallback must not replace the authoritative path.
    f.a.path = plugin;
    f.inventory.globalSkills = [global];
    const result = await prepareUsagePaths(f.inventory, {
      ...f.env,
      CODEX_HOME: override,
    });
    expect(global.usagePathIds).toHaveLength(1);
    expect(f.a.usagePathIds).toHaveLength(1);
    expect(result.find((x) => x.name === "global")?.paths).toContain(
      join(root, "SKILL.md"),
    );
  });
  it("uses explicit global Claude and Pi roots even without a HOME fallback", async () => {
    const f = await fixture();
    const claude = join(f.home, "claude-profile"),
      pi = join(f.home, "pi-profile");
    for (const root of [claude, pi]) {
      await mkdir(join(root, "skills", "review"), { recursive: true });
      await writeFile(
        join(root, "skills", "review", "SKILL.md"),
        "metadata only",
      );
    }
    const global = { ...installed(), scope: "global" as const };
    f.inventory.globalSkills = [global];
    await prepareUsagePaths(f.inventory, {
      CLAUDE_CONFIG_DIR: claude,
      PI_CODING_AGENT_DIR: pi,
    });
    expect(global.usagePathIds).toHaveLength(2);
  });
  it("does not credit arbitrary same-name paths, malformed names, nonregular declarations or missing installations", async () => {
    const f = await fixture();
    await f.file(join(f.first, "unrelated"));
    const invalid = installed("../review");
    const missing = { ...installed("missing"), installed: false };
    f.inventory.projects[0]!.checkouts[0]!.skills!.push(invalid, missing);
    await mkdir(join(f.second, ".agents", "skills", "review", "SKILL.md"), {
      recursive: true,
    });
    expect(await prepareUsagePaths(f.inventory, f.env)).toEqual([]);
    expect(f.a.usagePathIds).toEqual([]);
    expect(f.b.usagePathIds).toEqual([]);
    expect(invalid.usagePathIds).toEqual([]);
    expect(missing.usagePathIds).toBeUndefined();
  });
  it("honors cancellation before mutation", async () => {
    const f = await fixture();
    await f.file(f.first);
    const controller = new AbortController();
    controller.abort();
    await expect(
      prepareUsagePaths(f.inventory, f.env, controller.signal),
    ).rejects.toThrow();
    expect(f.a.usagePathIds).toBeUndefined();
  });
});
