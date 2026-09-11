import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeInstallationCoverage } from "../src/adapters/skills.js";
import { buildInventory } from "../src/core/inventory.js";

describe("inventory runtime", () => {
  it("attributes canonical installation coverage independently of detected agents", async () => {
    const root = await mkdtemp(join(tmpdir(), "skilloom-coverage-"));
    const path = join(root, ".agents/skills/review");
    await mkdir(path, { recursive: true });
    await writeFile(
      join(path, "SKILL.md"),
      "---\nname: review\ndescription: Review\n---\n",
    );
    const skill = {
      name: "review",
      source: "test/skills",
      path,
      scope: "project" as const,
      agents: ["codex"],
    };
    const result = await normalizeInstallationCoverage([skill], root, {
      HOME: root,
    });
    expect(result[0]?.agents).toEqual(
      expect.arrayContaining([
        "amp",
        "antigravity",
        "codex",
        "cursor",
        "gemini-cli",
        "github-copilot",
        "opencode",
        "warp",
      ]),
    );
    expect(result[0]?.detectedAgents).toEqual(["codex"]);
    expect(result[0]?.agents).not.toContain("claude-code");
    expect(
      await normalizeInstallationCoverage(
        [{ ...skill, path: join(root, "unrelated/review") }],
        root,
        { HOME: root },
      ),
    ).toEqual([{ ...skill, path: join(root, "unrelated/review") }]);
    const global = await normalizeInstallationCoverage(
      [{ ...skill, scope: "global" }],
      "/unrelated",
      { HOME: root },
    );
    expect(global[0]?.agents).toContain("warp");
  });

  it("bounds parallel checkout scans and reports completion", async () => {
    const root = await mkdtemp(join(tmpdir(), "skilloom-concurrent-"));
    await Promise.all(
      Array.from({ length: 7 }, async (_, i) => {
        await mkdir(join(root, `repo-${i}`));
        execFileSync("git", ["init", join(root, `repo-${i}`)]);
      }),
    );
    let active = 0;
    let peak = 0;
    const progress: number[] = [];
    const result = await buildInventory(
      {
        machine: {
          id: "test",
          name: "Test",
          workspaces: [{ path: root, depth: 1 }],
        },
        config: {
          version: 1,
          storage: { mode: "local" },
          profiles: { default: { skills: [] } },
          machines: { test: { profile: "default" } },
          projectProfiles: {},
          projects: {},
        },
        managed: new Set(),
        cwd: root,
        env: {},
      },
      {
        projectRemote: async () => null,
        listSkills: async (scope) => {
          if (scope === "global") return [];
          active += 1;
          peak = Math.max(peak, active);
          await new Promise((resolve) => setTimeout(resolve, 10));
          active -= 1;
          return [];
        },
        concurrency: 3,
        onProgress: (event) => {
          if (event.phase === "checkouts") progress.push(event.completed);
        },
      },
    );
    expect(peak).toBe(3);
    expect(result.discovery.checkoutsFound).toBe(7);
    expect(progress.at(-1)).toBe(7);
  });
});
