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

  it("does not mutate after cancellation", async () => {
    const home = await mkdtemp(join(tmpdir(), "skilloom-cli-"));
    const test = runtime(home);
    await runCli(["init", "--yes"], test.value);
    await setGlobalSkills(home, ["review"]);
    test.value.confirm = async () => false;
    let mutations = 0;
    test.value.run = async (_executable, args) => {
      if (args.includes("list")) return { code: 0, stdout: "[]", stderr: "" };
      mutations += 1;
      return { code: 0, stdout: "", stderr: "" };
    };
    expect(await runCli(["apply", "--json"], test.value)).toBe(5);
    expect(mutations).toBe(0);
  });
});
