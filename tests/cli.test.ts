import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ProcessResult } from "../src/adapters/skills.js";
import { type CliRuntime, runCli } from "../src/cli/app.js";

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

  it("prints help instead of hanging with no command on a non-TTY", async () => {
    const home = await mkdtemp(join(tmpdir(), "skilloom-cli-"));
    const test = runtime(home);
    expect(await runCli([], test.value)).toBe(0);
    expect(test.out.join("\n")).toContain("skilloom plan");
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
    await import("node:fs/promises").then(({ mkdir }) =>
      mkdir(join(project, ".git"), { recursive: true }),
    );
    test.value.cwd = project;
    await runCli(["project", "init"], test.value);
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

  it("diagnoses project discovery and repository state", async () => {
    const home = await mkdtemp(join(tmpdir(), "skilloom-cli-"));
    const test = runtime(home);
    await runCli(["init", "--yes"], test.value);
    const project = await mkdtemp(join(tmpdir(), "skilloom-project-"));
    await import("node:fs/promises").then(({ mkdir }) =>
      mkdir(join(project, ".git"), { recursive: true }),
    );
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
