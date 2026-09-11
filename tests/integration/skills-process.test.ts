import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SkillsAdapter } from "../../src/adapters/skills.js";

describe("skills process integration", () => {
  it("uses argv and captures partial failures through a fake npx", async () => {
    const root = await mkdtemp(join(tmpdir(), "skilloom-fake-npx-"));
    const executable = join(root, "npx");
    const log = join(root, "argv.log");
    await writeFile(
      executable,
      `#!/bin/sh
printf '%s\\n' "$@" >> "$SKILLOOM_TEST_LOG"
if [ "$2" = "list" ]; then
  printf '[{"name":"one","scope":"project","agents":["Codex"],"source":"acme/skills"}]'
  exit 0
fi
if [ "$2" = "remove" ]; then
  printf 'deliberate failure' >&2
  exit 7
fi
exit 0
`,
    );
    await chmod(executable, 0o755);
    const adapter = new SkillsAdapter(undefined, executable);
    const env = {
      ...process.env,
      HOME: root,
      XDG_CONFIG_HOME: join(root, ".config"),
      SKILLOOM_TEST_LOG: log,
    };
    expect(await adapter.list("project", root, env)).toHaveLength(1);
    const result = await adapter.execute(
      {
        kind: "remove",
        skill: {
          name: "one",
          source: "acme/skills",
          agents: ["codex"],
          scope: "project",
        },
        reasons: ["test"],
      },
      root,
      env,
    );
    expect(result.code).toBe(7);
    expect(result.stderr).toContain("deliberate failure");
    expect(await readFile(log, "utf8")).toContain("remove\none\n");
  });
});

it("reconciles pinned upstream universal coverage without requiring agent detection", async () => {
  const { mkdir } = await import("node:fs/promises");
  const { createRequire } = await import("node:module");
  const { dirname } = await import("node:path");
  const { runProcess, universalInstallationAgents } = await import(
    "../../src/adapters/skills.js"
  );
  const { planChanges } = await import("../../src/core/plan.js");
  const root = await mkdtemp(join(tmpdir(), "skilloom-upstream-coverage-"));
  const home = join(root, "home");
  const cwd = join(root, "checkout");
  const source = join(root, "source");
  await Promise.all([home, cwd, source].map((path) => mkdir(path)));
  await writeFile(
    join(source, "SKILL.md"),
    "---\nname: coverage-regression\ndescription: Temporary local integration fixture\n---\nReview code.\n",
  );
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    CODEX_HOME: join(home, ".codex"),
    CLAUDE_CONFIG_DIR: join(home, ".claude"),
    DISABLE_TELEMETRY: "1",
  };
  const adapter = new SkillsAdapter();
  const skill = {
    name: "coverage-regression",
    source,
    scope: "project" as const,
    agents: [
      "amp",
      "antigravity",
      "codex",
      "cursor",
      "gemini-cli",
      "github-copilot",
      "opencode",
      "warp",
    ],
    reasons: ["test"],
  };
  const added = await adapter.execute(
    { kind: "add", skill, reasons: ["test"] },
    cwd,
    env,
  );
  expect(added.code, added.stderr).toBe(0);
  const installed = await adapter.list("project", cwd, env);
  expect(installed[0]?.agents, JSON.stringify(installed)).toEqual(
    expect.arrayContaining(skill.agents),
  );
  expect(installed[0]?.detectedAgents).toBeDefined();
  expect(planChanges([skill], installed, new Set(), cwd)).toEqual([]);
  const globalSkill = { ...skill, scope: "global" as const };
  const globalAdded = await adapter.execute(
    { kind: "add", skill: globalSkill, reasons: ["test"] },
    cwd,
    env,
  );
  expect(globalAdded.code, globalAdded.stderr).toBe(0);
  const globalInstalled = await adapter.list("global", cwd, env);
  expect(globalInstalled[0]?.agents).toEqual(
    expect.arrayContaining(skill.agents),
  );
  expect(planChanges([globalSkill], globalInstalled, new Set())).toEqual([]);
  const upstreamRoot = dirname(
    createRequire(import.meta.url).resolve("skills/package.json"),
  );
  const upstream = await readFile(join(upstreamRoot, "dist/cli.mjs"), "utf8");
  const declared = [
    ...upstream.matchAll(
      /name: "([^"]+)",\n\s*displayName: "[^"]+",\n\s*skillsDir: "\.agents\/skills"/g,
    ),
  ].map((match) => match[1]);
  expect([...universalInstallationAgents].sort()).toEqual(declared.sort());
  const raw = await runProcess(
    process.execPath,
    [join(upstreamRoot, "bin/cli.mjs"), "list", "--json"],
    { cwd, env },
  );
  expect(raw.code).toBe(0);
  expect(JSON.parse(raw.stdout)[0].agents.length).toBeLessThan(
    installed[0]!.agents.length,
  );
}, 30000);
