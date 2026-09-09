import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { CliRuntime } from "../src/cli/runtime.js";
import {
  loadInventorySnapshot,
  resolveConfigPaths,
  saveInventorySnapshot,
} from "../src/core/config.js";
import { enrichInventoryMetadata } from "../src/core/enrich-metadata.js";
import type { InventorySkill, MachineInventory } from "../src/core/types.js";
import { createDashboardBackend } from "../src/tui/dashboard.js";

function fixture(home: string): MachineInventory {
  const skill: InventorySkill = {
    name: "review",
    source: null,
    scope: "project",
    agents: ["claude-code"],
    installed: true,
    desired: false,
    managed: false,
    reasons: [],
  };
  return {
    version: 1,
    cached: true,
    observedAt: "2026-09-01T00:00:00Z",
    machine: { id: "a", name: "Local", profile: "default" },
    discovery: {
      status: "found",
      roots: [],
      projectsFound: 1,
      checkoutsFound: 1,
    },
    profiles: ["default"],
    machines: [],
    globalSkills: [{ ...skill, scope: "global" }],
    projects: [
      {
        id: "repo",
        name: "repo",
        remote: null,
        operations: [],
        skills: [skill],
        checkouts: [{ path: join(home, "repo"), skills: [{ ...skill }] }],
      },
    ],
    operations: [],
    remoteObservations: [
      {
        machine: { id: "b", name: "Remote" },
        observedAt: "2026-08-01T00:00:00Z",
        globalSkills: [{ ...skill, scope: "global" }],
        projects: [{ id: "remote", name: "Remote", skills: [{ ...skill }] }],
      },
    ],
  };
}
async function environment() {
  const home = await mkdtemp(join(tmpdir(), "skilloom-enrich-"));
  for (const base of [home, join(home, "repo")]) {
    const path = join(base, ".claude/skills/review");
    await mkdir(path, { recursive: true });
    await writeFile(
      join(path, "SKILL.md"),
      "---\nname: review\ndescription: Test\ndisable-model-invocation: true\n---\nPrivate skill instructions\n",
    );
  }
  const logs = join(home, ".claude/projects/test");
  await mkdir(logs, { recursive: true });
  await writeFile(
    join(logs, "one.jsonl"),
    [
      {
        type: "assistant",
        timestamp: "2026-09-09T01:00:00Z",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "enrich-use",
              name: "Skill",
              input: { skill: "review" },
            },
          ],
        },
      },
      {
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "enrich-use",
              content: "Private result",
            },
          ],
        },
      },
    ]
      .map((x) => JSON.stringify(x))
      .join("\n") + "\n",
  );
  return { home, env: { HOME: home, XDG_CONFIG_HOME: join(home, ".config") } };
}
it("hydrates local declarations and usage without changing installation facts or remote observations", async () => {
  const { home, env } = await environment();
  const original = fixture(home),
    before = structuredClone(original);
  const cachePath = join(home, "usage-cache.json");
  const result = await enrichInventoryMetadata(original, env, cachePath);
  expect(original).toEqual(before);
  expect(result.globalSkills[0]?.metadata?.invocation).toBe("manual");
  expect(
    result.projects[0]?.checkouts[0]?.skills?.[0]?.metadata?.invocation,
  ).toBe("manual");
  expect(result.projects[0]?.skills[0]?.metadata?.invocation).toBe("manual");
  expect(result.skillUsage?.usage[0]?.count).toBe(1);
  expect(result.remoteObservations).toEqual(before.remoteObservations);
  expect(result.observedAt).toBe(before.observedAt);
  expect(await readFile(cachePath, "utf8")).not.toContain("Private");
});
it("aborts before reading or saving metadata", async () => {
  const { home, env } = await environment();
  const controller = new AbortController();
  controller.abort();
  await expect(
    enrichInventoryMetadata(
      fixture(home),
      env,
      join(home, "cache.json"),
      controller.signal,
    ),
  ).rejects.toThrow(/abort/i);
});
it("persists enrichment only when the saved snapshot still matches and never starts a subprocess", async () => {
  const { home, env } = await environment();
  const original = fixture(home);
  const paths = resolveConfigPaths(env);
  await saveInventorySnapshot(paths.inventoryPath, {
    ...original,
    cached: undefined,
  });
  const runtime: CliRuntime = {
    cwd: home,
    env,
    isTTY: false,
    stdout: () => {},
    stderr: () => {},
    confirm: async () => false,
    run: async () => {
      throw new Error("No subprocess allowed");
    },
  };
  const backend = createDashboardBackend(runtime, async () => {
    throw new Error("No command allowed");
  });
  const enriched = await backend.enrich!(original);
  expect(enriched.skillUsage?.usage[0]?.count).toBe(1);
  expect(
    (await loadInventorySnapshot(paths.inventoryPath))?.globalSkills[0]
      ?.metadata,
  ).toBeDefined();
  const newer = { ...original, observedAt: "2026-09-09T00:00:00Z" };
  await saveInventorySnapshot(paths.inventoryPath, newer);
  await backend.enrich!(original);
  expect(await loadInventorySnapshot(paths.inventoryPath)).toEqual(newer);
  await backend.shutdown();
});

it("hydrates legacy project aggregates without inventing checkout installation records", async () => {
  const { home, env } = await environment();
  const original = fixture(home);
  delete original.projects[0]!.checkouts[0]!.skills;
  const result = await enrichInventoryMetadata(
    original,
    env,
    join(home, "cache.json"),
  );
  expect(result.projects[0]?.skills[0]?.metadata?.invocation).toBe("manual");
  expect(result.projects[0]?.checkouts[0]?.skills).toBeUndefined();
});
