import { mkdtemp, readFile } from "node:fs/promises";
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
    const configPath = join(home, ".config", "skilloom", "config.yaml");
    const machineId = (
      await readFile(join(home, ".config", "skilloom", "machine-id"), "utf8")
    ).trim();
    await import("node:fs/promises").then(({ writeFile }) =>
      writeFile(
        configPath,
        `version: 1\nstorage: { mode: local }\nprofiles:\n  default:\n    skills:\n      - { source: acme/skills, name: review, agents: [codex] }\nmachines:\n  ${machineId}: { profile: default }\n`,
      ),
    );
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
});
