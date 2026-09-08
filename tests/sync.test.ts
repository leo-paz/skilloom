import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { GitAdapter } from "../src/adapters/git.js";
import { runProcess } from "../src/adapters/skills.js";
import { type CliRuntime, runCli } from "../src/cli/app.js";
import { loadProjectConfig, loadUserConfig } from "../src/core/config.js";

it("previews sync without installing and verifies actual installation before claiming convergence", async () => {
  const home = await mkdtemp(join(tmpdir(), "skilloom-sync-"));
  const output: string[] = [];
  let installed = false;
  let persistInstallation = false;
  let additions = 0;
  const runtime: CliRuntime = {
    cwd: home,
    env: {
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      CODEX_HOME: join(home, ".codex"),
    },
    isTTY: false,
    stdout: (line) => output.push(line),
    stderr: (line) => output.push(line),
    confirm: async () => true,
    run: async (_executable, args) => {
      if (args.includes("add")) {
        additions++;
        installed = persistInstallation;
      }
      return {
        code: 0,
        stdout: args.includes("list")
          ? JSON.stringify(
              installed
                ? [
                    {
                      name: "review",
                      scope: "global",
                      source: "acme/skills",
                      agents: ["codex"],
                    },
                  ]
                : [],
            )
          : "",
        stderr: "",
      };
    },
  };
  expect(await runCli(["init", "--yes", "--json"], runtime)).toBe(0);
  expect(
    await runCli(
      ["add", "review", "--source", "acme/skills", "--json"],
      runtime,
    ),
  ).toBe(0);
  expect(await runCli(["sync", "--dry-run", "--json"], runtime)).toBe(0);
  expect(JSON.parse(output.at(-1)!)).toMatchObject({
    command: "sync",
    dryRun: true,
    converged: false,
    operations: [{ kind: "add", name: "review" }],
  });
  expect(additions).toBe(0);
  expect(await runCli(["sync", "--json"], runtime)).toBe(5);
  expect(additions).toBe(0);
  expect(await runCli(["sync", "--yes", "--json"], runtime)).toBe(2);
  expect(JSON.parse(output.at(-1)!)).toMatchObject({
    ok: false,
    converged: false,
    published: false,
  });
  persistInstallation = true;
  expect(await runCli(["sync", "--yes", "--json"], runtime)).toBe(0);
  expect(JSON.parse(output.at(-1)!)).toMatchObject({
    ok: true,
    command: "sync",
    converged: true,
    published: false,
  });
});

it("syncs shared policy into each machine and publishes verified observations through Git", async () => {
  const root = await mkdtemp(join(tmpdir(), "skilloom-sync-git-"));
  const remote = join(root, "remote.git");
  const git = new GitAdapter();
  await git.initBare(remote);
  const machine = async (name: string) => {
    const home = join(root, name);
    await mkdir(home);
    const output: string[] = [];
    let installed = false;
    const runtime: CliRuntime = {
      cwd: home,
      env: {
        HOME: home,
        XDG_CONFIG_HOME: join(home, ".config"),
        CODEX_HOME: join(home, ".codex"),
      },
      isTTY: false,
      stdout: (line) => output.push(line),
      stderr: (line) => output.push(line),
      confirm: async () => true,
      run: async (_executable, args) => {
        if (args.includes("add")) installed = true;
        return {
          code: 0,
          stdout: args.includes("list")
            ? JSON.stringify(
                installed
                  ? [
                      {
                        name: "review",
                        scope: "global",
                        source: "acme/skills",
                        agents: ["codex"],
                      },
                    ]
                  : [],
              )
            : "",
          stderr: "",
        };
      },
    };
    expect(
      await runCli(
        [
          "init",
          "--storage",
          "managed",
          "--repository",
          remote,
          "--yes",
          "--json",
        ],
        runtime,
      ),
      output.join("\n"),
    ).toBe(0);
    return { runtime, output };
  };
  const one = await machine("one");
  const two = await machine("two");
  expect(
    await runCli(
      ["add", "review", "--source", "acme/skills", "--json"],
      one.runtime,
    ),
  ).toBe(0);
  for (const current of [one, two]) {
    expect(
      await runCli(["sync", "--yes", "--json"], current.runtime),
      current.output.join("\n"),
    ).toBe(0);
    expect(JSON.parse(current.output.at(-1) ?? "{}")).toMatchObject({
      converged: true,
      published: true,
      completed: [{ name: "review", scope: "global" }],
    });
  }
  expect(await runCli(["inventory", "--json"], one.runtime)).toBe(0);
  expect(JSON.parse(one.output.at(-1) ?? "{}").machines).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ local: false, globalSkills: 1, changes: 0 }),
    ]),
  );
  const verification = join(root, "verify");
  await git.clone(remote, verification);
  const id = JSON.parse(two.output.at(-1) ?? "{}").machine.id;
  const observation = await readFile(
    join(verification, "observations", `${id}.json`),
    "utf8",
  );
  expect(observation).not.toContain(root);
  expect(JSON.parse(observation).globalSkills).toEqual([
    expect.objectContaining({ name: "review", installed: true, desired: true }),
  ]);
});

it("targets personal project additions by remote and writes shared requirements into the repository", async () => {
  const home = await mkdtemp(join(tmpdir(), "skilloom-project-add-"));
  const project = join(home, "core");
  await mkdir(project, { recursive: true });
  await runProcess("git", ["init"], { cwd: project, env: {} });
  await runProcess(
    "git",
    ["remote", "add", "origin", "git@github.com:acme/core.git"],
    { cwd: project, env: {} },
  );
  const output: string[] = [];
  const runtime: CliRuntime = {
    cwd: project,
    env: { HOME: home, XDG_CONFIG_HOME: join(home, ".config") },
    isTTY: false,
    stdout: (line) => output.push(line),
    stderr: (line) => output.push(line),
    confirm: async () => true,
    run: (executable, args, options) =>
      executable === "git"
        ? runProcess(executable, args, options)
        : Promise.resolve({ code: 0, stdout: "[]", stderr: "" }),
  };
  expect(await runCli(["init", "--yes", "--json"], runtime)).toBe(0);
  expect(
    await runCli(
      ["add", "review", "--source", "acme/skills", "--project", "--json"],
      runtime,
    ),
  ).toBe(0);
  const config = await loadUserConfig(
    join(home, ".config", "skilloom", "config.yaml"),
  );
  expect(config.projects["github.com/acme/core"]?.skills).toEqual([
    { name: "review", source: "acme/skills", agents: ["codex"] },
  ]);
  expect(
    await loadProjectConfig(join(project, ".skilloom.yaml")),
  ).toBeUndefined();
  expect(
    await runCli(
      [
        "add",
        "research",
        "--source",
        "acme/skills",
        "--project",
        "--shared",
        "--agents",
        "codex,claude-code",
        "--json",
      ],
      runtime,
    ),
  ).toBe(0);
  expect(
    (await loadProjectConfig(join(project, ".skilloom.yaml")))?.skills,
  ).toEqual([
    {
      name: "research",
      source: "acme/skills",
      agents: ["claude-code", "codex"],
    },
  ]);
  expect(
    await runCli(
      [
        "add",
        "unknown",
        "--source",
        "acme/skills",
        "--to",
        "project:unknown",
        "--json",
      ],
      runtime,
    ),
  ).toBe(3);
  expect(JSON.parse(output.at(-1) ?? "{}").error.message).toContain(
    "was not discovered",
  );
  await runProcess(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "--allow-empty",
      "-m",
      "Seed",
    ],
    { cwd: project, env: {} },
  );
  const linked = join(home, "linked");
  await runProcess("git", ["worktree", "add", "-b", "linked", linked], {
    cwd: project,
    env: {},
  });
  expect(
    await runCli(
      [
        "add",
        "worktree-only",
        "--source",
        "acme/skills",
        "--project",
        "--json",
      ],
      { ...runtime, cwd: linked },
    ),
  ).toBe(3);
  expect(JSON.parse(output.at(-1) ?? "{}").error.message).toContain(
    "linked worktree",
  );
});
