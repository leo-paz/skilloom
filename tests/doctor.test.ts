import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { initializeConfiguration } from "../src/cli/configuration.js";
import { doctor, inspectRuntime } from "../src/cli/doctor.js";
import type { CliRuntime } from "../src/cli/runtime.js";

async function fixture(version = "1.5.25") {
  const home = await mkdtemp(join(tmpdir(), "skilloom-doctor-"));
  const output: string[] = [];
  const calls: Array<{ executable: string; args: string[] }> = [];
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
    run: async (executable, args) => {
      calls.push({ executable, args });
      return {
        code: 0,
        stdout:
          executable === process.execPath ? version : "git version 2.40.0",
        stderr: "",
      };
    },
  };
  await initializeConfiguration([], runtime, true);
  return { runtime, output, calls };
}
describe("doctor pinned runtime diagnostics", () => {
  it("checks the pinned installed skills binary with the current executable and never invokes npx", async () => {
    const f = await fixture();
    expect(await doctor([], f.runtime, true)).toBe(0);
    const result = JSON.parse(f.output.at(-1)!);
    expect(result.ok).toBe(true);
    expect(f.calls.some((call) => call.executable === "npx")).toBe(false);
    expect(f.calls).toContainEqual({
      executable: process.execPath,
      args: [expect.stringMatching(/skills\/bin\/cli\.mjs$/), "--version"],
    });
    expect(
      result.checks.find((check: { name: string }) => check.name === "skills")
        .detail,
    ).toContain("1.5.25");
  });
  it("fails a mismatching executed version instead of trusting an unrelated CLI", async () => {
    const f = await fixture("9.9.9");
    expect(await doctor([], f.runtime, true)).toBe(4);
    expect(JSON.parse(f.output.at(-1)!).ok).toBe(false);
  });
  it("reports dependency execution failures without leaking environment secrets", async () => {
    const f = await fixture();
    f.runtime.env.API_TOKEN = "private-fixture-token";
    f.runtime.run = async () => ({
      code: 1,
      stdout: "",
      stderr: "error private-fixture-token",
    });
    expect(await doctor([], f.runtime, true)).toBe(4);
    expect(f.output.at(-1)).not.toContain("private-fixture-token");
  });
  it("checks the minimum supported Node compatibility and names Bun explicitly", () => {
    expect(inspectRuntime("18.20.0").ok).toBe(false);
    expect(inspectRuntime("20.0.0").ok).toBe(true);
    expect(inspectRuntime("invalid").ok).toBe(false);
    expect(inspectRuntime("24.0.0", "1.3.0").detail).toContain("Bun 1.3.0");
  });
});
