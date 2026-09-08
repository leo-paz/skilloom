import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ProcessResult } from "../src/adapters/skills.js";
import { type CliRuntime, runCli } from "../src/cli/app.js";
import { loadUserConfig, saveUserConfig } from "../src/core/config.js";

async function initializeGit(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  execFileSync("git", ["init", "-q", path]);
}

function runtime(home: string): {
  value: CliRuntime;
  out: string[];
  err: string[];
} {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    value: {
      cwd: home,
      env: {
        HOME: home,
        XDG_CONFIG_HOME: join(home, ".config"),
        CODEX_HOME: join(home, ".codex"),
      },
      isTTY: false,
      stdout: (line) => out.push(line),
      stderr: (line) => err.push(line),
      run: async (_executable, args): Promise<ProcessResult> => {
        if (args.includes("list")) return { code: 0, stdout: "[]", stderr: "" };
        return { code: 0, stdout: "", stderr: "" };
      },
      confirm: async () => true,
    },
  };
}

async function setGlobalSkills(home: string, names: string[]): Promise<void> {
  const configPath = join(home, ".config", "skilloom", "config.yaml");
  const machineId = (
    await readFile(join(home, ".config", "skilloom", "machine-id"), "utf8")
  ).trim();
  const skills = names
    .map(
      (name) =>
        `      - { source: acme/skills, name: ${name}, agents: [codex] }`,
    )
    .join("\n");
  await writeFile(
    configPath,
    `version: 1\nstorage: { mode: local }\nprofiles:\n  default:\n    skills:\n${skills}\nmachines:\n  ${machineId}: { profile: default }\n`,
  );
}

describe("CLI", () => {
  it("does not spread a skill from one independent clone to another during adoption", async () => {
    const home = await mkdtemp(join(tmpdir(), "skilloom-clones-"));
    const first = join(home, "dev", "first");
    const second = join(home, "dev", "second");
    await initializeGit(first);
    await initializeGit(second);
    const test = runtime(home);
    test.value.run = async (executable, args, options) => {
      if (executable === "git")
        return {
          code: 0,
          stdout: "git@github.com:acme/project.git",
          stderr: "",
        };
      return {
        code: 0,
        stderr: "",
        stdout: JSON.stringify(
          args.includes("list") &&
            !args.includes("--global") &&
            options.cwd === first
            ? [
                {
                  name: "review",
                  source: "acme/skills",
                  agents: ["codex"],
                  scope: "project",
                },
              ]
            : [],
        ),
      };
    };
    expect(
      await runCli(["setup", join(home, "dev"), "--json"], test.value),
    ).toBe(0);
    const config = await loadUserConfig(
      join(home, ".config", "skilloom", "config.yaml"),
    );
    expect(config.projects).toEqual({});
    expect(await runCli(["plan", "--all", "--json"], test.value)).toBe(0);
    expect(JSON.parse(test.out.at(-1) ?? "{}").operations).toEqual([]);
  });
  it("reports the version published in package metadata", async () => {
    const home = await mkdtemp(join(tmpdir(), "skilloom-cli-"));
    const test = runtime(home);
    const packageMetadata = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };

    expect(await runCli(["--version"], test.value)).toBe(0);
    expect(test.out).toEqual([packageMetadata.version]);
  });

  it("initializes local configuration and reports JSON", async () => {
    const home = await mkdtemp(join(tmpdir(), "skilloom-cli-"));
    const test = runtime(home);
    const code = await runCli(["init", "--yes", "--json"], test.value);
    expect(code).toBe(0);
    expect(JSON.parse(test.out.at(-1) ?? "{}")).toMatchObject({
      ok: true,
      command: "init",
    });
    expect(
      await readFile(join(home, ".config", "skilloom", "config.yaml"), "utf8"),
    ).toContain("default");
  });

  it("sets up a workspace and adopts existing global and project skills", async () => {
    const home = await mkdtemp(join(tmpdir(), "skilloom-setup-"));
    const workspace = join(home, "dev");
    const project = join(workspace, "personal", "skilloom");
    await initializeGit(project);
    const test = runtime(home);
    const mutations: string[][] = [];
    test.value.run = async (executable, args) => {
      if (executable === "git") {
        return {
          code: 0,
          stdout: "git@github.com:leo-paz/skilloom.git\n",
          stderr: "",
        };
      }
      if (args.includes("list")) {
        const global = args.includes("--global");
        return {
          code: 0,
          stdout: JSON.stringify([
            {
              name: global ? "code-review" : "tdd",
              scope: global ? "global" : "project",
              agents: ["Codex"],
              source: "mattpocock/skills",
            },
          ]),
          stderr: "",
        };
      }
      mutations.push(args);
      return { code: 0, stdout: "", stderr: "" };
    };

    expect(
      await runCli(
        ["setup", "~/dev", "--machine-name", "Test Mac", "--json"],
        test.value,
      ),
    ).toBe(0);
    const payload = JSON.parse(test.out.at(-1) ?? "{}");
    expect(payload).toMatchObject({
      ok: true,
      command: "setup",
      inventory: {
        machine: { name: "Test Mac" },
        discovery: { projectsFound: 1 },
      },
      adoption: { adopted: 2, unmanaged: 0 },
    });
    const config = await readFile(
      join(home, ".config", "skilloom", "config.yaml"),
      "utf8",
    );
    expect(config).toContain("name: code-review");
    expect(config).toContain("github.com/leo-paz/skilloom");
    expect(config).toContain("name: tdd");
    const state = await readFile(
      join(home, ".config", "skilloom", "state.json"),
      "utf8",
    );
    expect(state).toContain("global:code-review");
    expect(state).toContain("project:");
    expect(mutations).toEqual([]);

    test.out.length = 0;
    expect(await runCli(["inventory", "--json"], test.value)).toBe(0);
    expect(JSON.parse(test.out.at(-1) ?? "{}")).toMatchObject({
      ok: true,
      command: "inventory",
      machine: { name: "Test Mac", profile: "default" },
      discovery: { projectsFound: 1 },
      globalSkills: [
        { name: "code-review", installed: true, desired: true, managed: true },
      ],
      projects: [
        {
          id: "github.com/leo-paz/skilloom",
          skills: [
            { name: "tdd", installed: true, desired: true, managed: true },
          ],
        },
      ],
    });

    test.out.length = 0;
    expect(await runCli(["observe", "--json"], test.value)).toBe(0);
    expect(JSON.parse(test.out.at(-1) ?? "{}")).toMatchObject({
      ok: true,
      command: "observe",
      changed: false,
      published: false,
    });
    expect(
      JSON.parse(
        await readFile(
          join(home, ".config", "skilloom", "inventory.json"),
          "utf8",
        ),
      ),
    ).toMatchObject({ machine: { name: "Test Mac" } });

    test.out.length = 0;
    expect(await runCli(["observe", "--json"], test.value)).toBe(0);
    expect(JSON.parse(test.out.at(-1) ?? "{}")).toMatchObject({
      changed: false,
      published: false,
    });

    test.out.length = 0;
    expect(
      await runCli(
        ["setup", workspace, "--machine-name", "Test Mac", "--json"],
        test.value,
      ),
    ).toBe(0);
    expect(JSON.parse(test.out.at(-1) ?? "{}").adoption).toEqual({
      adopted: 0,
      unmanaged: 0,
    });
    const machine = JSON.parse(
      await readFile(join(home, ".config", "skilloom", "machine.json"), "utf8"),
    );
    expect(machine.workspaces).toEqual([{ path: workspace, depth: 3 }]);
  });

  it("plans, checks drift, and applies with stable JSON", async () => {
    const home = await mkdtemp(join(tmpdir(), "skilloom-cli-"));
    const test = runtime(home);
    await runCli(["init", "--yes"], test.value);
    await setGlobalSkills(home, ["review"]);
    expect(await runCli(["plan", "--check", "--json"], test.value)).toBe(2);
    const plan = JSON.parse(test.out.at(-1) ?? "{}");
    expect(plan.operations[0].command).toEqual({
      executable: "npx",
      arguments: [
        "skills",
        "add",
        "acme/skills",
        "--skill",
        "review",
        "--agent",
        "codex",
        "--global",
        "--yes",
      ],
    });
    expect(await runCli(["apply", "--yes", "--json"], test.value)).toBe(0);
    expect(test.out.some((line) => line.includes('"completed"'))).toBe(true);
  });

  it("plans and applies desired state across discovered project checkouts", async () => {
    const home = await realpath(
      await mkdtemp(join(tmpdir(), "skilloom-workspace-apply-")),
    );
    const workspace = join(home, "dev");
    const project = join(workspace, "personal", "skilloom");
    await initializeGit(project);
    const test = runtime(home);
    const executions: Array<{ args: string[]; cwd: string }> = [];
    test.value.run = async (executable, args, options) => {
      if (executable === "git") {
        return {
          code: 0,
          stdout: "git@github.com:leo-paz/skilloom.git\n",
          stderr: "",
        };
      }
      if (args.includes("list")) return { code: 0, stdout: "[]", stderr: "" };
      executions.push({ args, cwd: options.cwd });
      return { code: 0, stdout: "", stderr: "" };
    };
    await runCli(
      ["setup", workspace, "--machine-name", "Test Mac", "--no-adopt"],
      test.value,
    );
    await runCli(
      [
        "add",
        "tdd",
        "--source",
        "mattpocock/skills",
        "--to",
        "project:skilloom",
      ],
      test.value,
    );

    expect(await runCli(["plan", "--all", "--json"], test.value)).toBe(0);
    expect(JSON.parse(test.out.at(-1) ?? "{}")).toMatchObject({
      ok: true,
      command: "plan",
      converged: false,
      operations: [
        { name: "tdd", project: "github.com/leo-paz/skilloom", cwd: project },
      ],
    });
    expect(
      await runCli(["apply", "--all", "--yes", "--json"], test.value),
    ).toBe(0);
    expect(executions).toEqual([
      {
        cwd: project,
        args: [
          "skills",
          "add",
          "mattpocock/skills",
          "--skill",
          "tdd",
          "--agent",
          "codex",
          "--yes",
        ],
      },
    ]);
  });

  it("prints help instead of hanging with no command on a non-TTY", async () => {
    const home = await mkdtemp(join(tmpdir(), "skilloom-cli-"));
    const test = runtime(home);
    expect(await runCli([], test.value)).toBe(0);
    expect(test.out.join("\n")).toContain("skilloom plan");
  });

  it("prints command-specific help for agent discovery", async () => {
    const home = await mkdtemp(join(tmpdir(), "skilloom-help-"));
    const test = runtime(home);
    expect(await runCli(["setup", "--help"], test.value)).toBe(0);
    expect(test.out.at(-1)).toContain("Usage: skilloom setup [WORKSPACE]");
    expect(test.out.at(-1)).toContain("--no-adopt");

    expect(await runCli(["add", "--help"], test.value)).toBe(0);
    expect(test.out.at(-1)).toContain("profile:NAME or project:ID");
  });

  it("returns a JSON error envelope for invalid commands", async () => {
    const home = await mkdtemp(join(tmpdir(), "skilloom-cli-"));
    const test = runtime(home);
    expect(await runCli(["nope", "--json"], test.value)).toBe(3);
    expect(JSON.parse(test.err.at(-1) ?? "{}")).toMatchObject({ ok: false });
  });

  it("distinguishes upstream execution failures from invalid input", async () => {
    const home = await mkdtemp(join(tmpdir(), "skilloom-cli-"));
    const test = runtime(home);
    await runCli(["init", "--yes"], test.value);
    test.value.run = async () => ({
      code: 7,
      stdout: "",
      stderr: "upstream unavailable",
    });

    expect(await runCli(["plan", "--check", "--json"], test.value)).toBe(4);
    expect(JSON.parse(test.err.at(-1) ?? "{}")).toMatchObject({
      ok: false,
      error: { code: "execution_failed" },
    });
  });

  it("records completed work and reports pending work after a partial failure", async () => {
    const home = await mkdtemp(join(tmpdir(), "skilloom-cli-"));
    const test = runtime(home);
    await runCli(["init", "--yes"], test.value);
    await setGlobalSkills(home, ["first", "second"]);
    test.value.run = async (_executable, args) => {
      if (args.includes("list")) return { code: 0, stdout: "[]", stderr: "" };
      if (args.includes("second")) {
        return { code: 9, stdout: "", stderr: "deliberate failure" };
      }
      return { code: 0, stdout: "", stderr: "" };
    };
    expect(await runCli(["apply", "--yes", "--json"], test.value)).toBe(4);
    const payload = JSON.parse(test.err.at(-1) ?? "{}");
    expect(payload.completed).toHaveLength(1);
    expect(payload.pending).toHaveLength(1);
    expect(
      await readFile(join(home, ".config", "skilloom", "state.json"), "utf8"),
    ).toContain("global:first");
  });

  it("streams interactive apply output without duplicating it", async () => {
    const home = await mkdtemp(join(tmpdir(), "skilloom-cli-"));
    const test = runtime(home);
    await runCli(["init", "--yes"], test.value);
    await setGlobalSkills(home, ["review"]);
    const streamed: string[] = [];
    Object.assign(test.value, {
      isTTY: true,
      writeStdout: (chunk: string) => streamed.push(chunk),
    });
    test.value.run = async (_executable, args, options) => {
      if (args.includes("list")) return { code: 0, stdout: "[]", stderr: "" };
      const output = options as typeof options & {
        onStdout?: (chunk: string) => void;
      };
      output.onStdout?.("installing review\n");
      return { code: 0, stdout: "installing review\n", stderr: "" };
    };

    expect(await runCli(["apply", "--yes"], test.value)).toBe(0);
    expect(streamed).toEqual(["installing review\n"]);
    expect(
      test.out.filter((line) => line.includes("installing review")),
    ).toEqual([]);
  });

  it("does not mutate after cancellation", async () => {
    const home = await mkdtemp(join(tmpdir(), "skilloom-cli-"));
    const test = runtime(home);
    await runCli(["init", "--yes"], test.value);
    await setGlobalSkills(home, ["review"]);
    test.value.confirm = async () => {
      throw new Error("non-TTY commands must not prompt");
    };
    let mutations = 0;
    test.value.run = async (_executable, args) => {
      if (args.includes("list")) return { code: 0, stdout: "[]", stderr: "" };
      mutations += 1;
      return { code: 0, stdout: "", stderr: "" };
    };
    expect(await runCli(["apply", "--json"], test.value)).toBe(5);
    expect(mutations).toBe(0);
  });

  it("updates one named skill in one explicit scope", async () => {
    const home = await mkdtemp(join(tmpdir(), "skilloom-update-"));
    const test = runtime(home);
    const calls: string[][] = [];
    test.value.run = async (_executable, args) => {
      calls.push(args);
      return { code: 0, stdout: "", stderr: "" };
    };

    expect(
      await runCli(
        ["update", "code-review", "--scope", "global", "--yes", "--json"],
        test.value,
      ),
    ).toBe(0);
    expect(calls).toEqual([
      ["skills", "update", "code-review", "--global", "--yes"],
    ]);
  });

  it("includes published observations from other machines in inventory", async () => {
    const home = await mkdtemp(join(tmpdir(), "skilloom-remote-observation-"));
    const test = runtime(home);
    await runCli(["init", "--yes"], test.value);
    const configPath = join(home, ".config", "skilloom", "config.yaml");
    const config = await loadUserConfig(configPath);
    config.machines.remote = { profile: "default", name: "Leo's MacBook" };
    await saveUserConfig(configPath, config);
    const observations = join(home, ".config", "skilloom", "observations");
    await mkdir(observations, { recursive: true });
    await writeFile(
      join(observations, "remote.json"),
      JSON.stringify({
        version: 1,
        observedAt: "2026-08-26T12:00:00.000Z",
        machine: { id: "remote", name: "Leo's MacBook", profile: "default" },
        discovery: { status: "found", projectsFound: 4, checkoutsFound: 4 },
        globalSkills: [{ name: "review", installed: true }],
        projects: [
          {
            id: "github.com/acme/Core",
            name: "Core",
            skills: [
              {
                name: "review",
                source: null,
                scope: "project",
                agents: ["codex"],
                installed: true,
                desired: false,
                managed: false,
                reasons: [],
                ownership: "repository",
              },
            ],
          },
        ],
        operations: [],
      }),
    );

    expect(await runCli(["inventory", "--json"], test.value)).toBe(0);
    expect(JSON.parse(test.out.at(-1) ?? "{}").machines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "remote",
          name: "Leo's MacBook",
          observedAt: "2026-08-26T12:00:00.000Z",
          projects: 4,
          globalSkills: 1,
        }),
      ]),
    );
    expect(
      JSON.parse(test.out.at(-1) ?? "{}").remoteObservations,
    ).toMatchObject([
      {
        machine: { id: "remote" },
        projects: [
          {
            name: "Core",
            skills: [{ name: "review", ownership: "repository" }],
          },
        ],
      },
    ]);
  });

  it("connects to an existing external config and assigns this machine", async () => {
    const home = await mkdtemp(join(tmpdir(), "skilloom-cli-"));
    const externalPath = join(home, "shared.yaml");
    await writeFile(
      externalPath,
      "version: 1\nstorage: { mode: external, path: /tmp/shared.yaml }\nprofiles:\n  work: { skills: [] }\nmachines: {}\n",
    );
    const test = runtime(home);
    expect(
      await runCli(
        [
          "init",
          "--storage",
          "external",
          "--path",
          externalPath,
          "--profile",
          "work",
          "--json",
        ],
        test.value,
      ),
    ).toBe(0);
    const machineId = (
      await readFile(join(home, ".config", "skilloom", "machine-id"), "utf8")
    ).trim();
    expect(await readFile(externalPath, "utf8")).toContain(
      `${machineId}:\n    profile: work`,
    );
  });

  it("creates profiles, selects one, and edits the project manifest", async () => {
    const home = await mkdtemp(join(tmpdir(), "skilloom-cli-"));
    const test = runtime(home);
    await runCli(["init", "--yes"], test.value);
    expect(await runCli(["config", "--add-profile", "work"], test.value)).toBe(
      0,
    );
    expect(
      await runCli(
        [
          "config",
          "--add-skill",
          "review",
          "--source",
          "acme/skills",
          "--to-profile",
          "work",
          "--agent",
          "codex",
        ],
        test.value,
      ),
    ).toBe(0);
    expect(await runCli(["config", "--profile", "work"], test.value)).toBe(0);
    expect(
      await readFile(join(home, ".config", "skilloom", "config.yaml"), "utf8"),
    ).toContain("name: review");

    const project = await mkdtemp(join(tmpdir(), "skilloom-project-"));
    await initializeGit(project);
    test.value.cwd = project;
    expect(
      await runCli(
        [
          "project",
          "add",
          "--source",
          "acme/skills",
          "--skill",
          "review",
          "--agent",
          "codex",
        ],
        test.value,
      ),
    ).toBe(0);
    expect(await readFile(join(project, ".skilloom.yaml"), "utf8")).toContain(
      "name: review",
    );
    expect(
      await runCli(["project", "remove", "--skill", "review"], test.value),
    ).toBe(0);
    expect(
      await readFile(join(project, ".skilloom.yaml"), "utf8"),
    ).not.toContain("name: review");
  });

  it("adds, edits, moves, and removes policy in atomic commands", async () => {
    const home = await mkdtemp(join(tmpdir(), "skilloom-policy-"));
    const test = runtime(home);
    await runCli(["init", "--yes"], test.value);
    const configPath = join(home, ".config", "skilloom", "config.yaml");
    const initialConfig = await loadUserConfig(configPath);
    initialConfig.projects["github.com/leo-paz/skilloom"] = { skills: [] };
    await saveUserConfig(configPath, initialConfig);

    expect(
      await runCli(
        [
          "add",
          "research",
          "tdd",
          "--source",
          "mattpocock/skills",
          "--to",
          "profile:default",
          "--agent",
          "codex",
          "--json",
        ],
        test.value,
      ),
    ).toBe(0);
    expect(
      await runCli(
        [
          "edit",
          "research",
          "--in",
          "profile:default",
          "--agents",
          "codex,claude-code",
          "--json",
        ],
        test.value,
      ),
    ).toBe(0);
    let config = await readFile(configPath, "utf8");
    expect(config).toContain("claude-code");

    expect(
      await runCli(
        [
          "move",
          "research",
          "--from",
          "profile:default",
          "--to",
          "project:skilloom",
          "--json",
        ],
        test.value,
      ),
    ).toBe(0);
    config = await readFile(configPath, "utf8");
    expect(config.match(/name: research/g)).toHaveLength(1);
    expect(config).toContain("github.com/leo-paz/skilloom");

    expect(
      await runCli(
        ["remove", "research", "--from", "project:skilloom", "--json"],
        test.value,
      ),
    ).toBe(0);
    config = await readFile(configPath, "utf8");
    expect(config).not.toContain("name: research");
    expect(config).toContain("name: tdd");
  });

  it("diagnoses project discovery and repository state", async () => {
    const home = await mkdtemp(join(tmpdir(), "skilloom-cli-"));
    const test = runtime(home);
    await runCli(["init", "--yes"], test.value);
    const project = await mkdtemp(join(tmpdir(), "skilloom-project-"));
    await initializeGit(project);
    test.value.cwd = project;

    expect(await runCli(["doctor", "--json"], test.value)).toBe(0);
    const checks = JSON.parse(test.out.at(-1) ?? "{}").checks as Array<{
      name: string;
    }>;
    expect(checks.map((check) => check.name)).toEqual(
      expect.arrayContaining(["project", "repository"]),
    );
  });
});
