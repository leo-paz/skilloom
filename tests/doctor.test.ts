import * as filesystem from "node:fs/promises";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initializeConfiguration } from "../src/cli/configuration.js";
import {
  doctor,
  inspectLocalInstallations,
  inspectRuntime,
} from "../src/cli/doctor.js";
import type { CliRuntime } from "../src/cli/runtime.js";

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
}));
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

async function fixture(version = "1.5.25", initialize = true) {
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
  if (initialize) await initializeConfiguration([], runtime, true);
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

describe("doctor installation diagnostics", () => {
  it("checks an uninitialized home without subprocesses or writing Skilloom state", async () => {
    const f = await fixture("1.5.25", false);
    const root = join(f.runtime.env.HOME!, ".agents", "skills");
    await mkdir(root, { recursive: true });
    await symlink("missing", join(root, "review"));
    const before = await readdir(f.runtime.env.HOME!);
    expect(await doctor(["--installations"], f.runtime, true)).toBe(0);
    const report = JSON.parse(f.output.at(-1)!);
    expect(report.command).toBe("doctor");
    expect(report.ok).toBe(true);
    expect(report.installations.machineId).toBeNull();
    expect(report.installations.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: join(root, "review"),
          status: "target-missing",
        }),
      ]),
    );
    expect(f.calls).toEqual([]);
    expect(await readdir(f.runtime.env.HOME!)).toEqual(before);
  });

  it("checks current Git checkout roots without discovering other projects", async () => {
    const f = await fixture("1.5.25", false);
    const home = f.runtime.env.HOME!;
    await mkdir(join(home, "repo", ".git"), { recursive: true });
    await mkdir(join(home, "repo", ".claude", "skills"), { recursive: true });
    await symlink("missing", join(home, "repo", ".claude", "skills", "local"));
    await mkdir(join(home, "other", ".agents", "skills"), { recursive: true });
    await symlink(
      "missing",
      join(home, "other", ".agents", "skills", "unrecorded"),
    );
    f.runtime.cwd = join(home, "repo");
    expect(await doctor(["--installations"], f.runtime, true)).toBe(0);
    const report = JSON.parse(f.output.at(-1)!).installations;
    expect(
      report.entries.some((entry: { name: string }) => entry.name === "local"),
    ).toBe(true);
    expect(
      report.entries.some(
        (entry: { name: string }) => entry.name === "unrecorded",
      ),
    ).toBe(false);
    expect(f.calls).toEqual([]);
  });

  it("uses saved checkout paths only for this machine, never remote observations", async () => {
    const f = await fixture();
    f.calls.length = 0;
    const home = f.runtime.env.HOME!;
    const app = join(home, ".config", "skilloom");
    const machineId = (await readFile(join(app, "machine-id"), "utf8")).trim();
    const checkout = join(home, "saved");
    await mkdir(join(checkout, ".agents", "skills"), { recursive: true });
    await symlink(
      "missing",
      join(checkout, ".agents", "skills", "saved-skill"),
    );
    const inventory = {
      version: 1,
      machine: { id: machineId, name: "Local" },
      projects: [{ checkouts: [{ path: checkout }] }],
      remoteObservations: [
        { projects: [{ checkouts: [{ path: join(home, "remote") }] }] },
      ],
    };
    await writeFile(join(app, "inventory.json"), JSON.stringify(inventory));
    expect(await doctor(["--installations"], f.runtime, true)).toBe(0);
    expect(JSON.parse(f.output.at(-1)!).installations.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "saved-skill" }),
      ]),
    );
    inventory.machine.id = "00000000-0000-0000-0000-000000000000";
    await writeFile(join(app, "inventory.json"), JSON.stringify(inventory));
    expect(await doctor(["--installations"], f.runtime, true)).toBe(4);
    const result = JSON.parse(f.output.at(-1)!);
    expect(result.ok).toBe(false);
    expect(result.installations.entries).toEqual([]);
    expect(result.installations.coverage.limitations.join(" ")).toMatch(
      /identity|machine/i,
    );
    expect(f.calls).toEqual([]);
  });

  it("honors a USERPROFILE-only home without initializing configuration", async () => {
    const f = await fixture("1.5.25", false);
    const home = f.runtime.env.HOME!;
    f.runtime.env.USERPROFILE = home;
    delete f.runtime.env.HOME;
    await mkdir(join(home, ".claude", "skills"), { recursive: true });
    await symlink("missing", join(home, ".claude", "skills", "windows-home"));
    expect(await doctor(["--installations"], f.runtime, true)).toBe(0);
    expect(JSON.parse(f.output.at(-1)!).installations.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "windows-home" }),
      ]),
    );
    expect(f.calls).toEqual([]);
  });

  it("reports cancellation as incomplete instead of passing an empty check", async () => {
    const f = await fixture("1.5.25", false);
    const controller = new AbortController();
    controller.abort();
    f.runtime.signal = controller.signal;
    expect(await doctor(["--installations"], f.runtime, true)).toBe(4);
    const report = JSON.parse(f.output.at(-1)!);
    expect(report.ok).toBe(false);
    expect(report.installations.coverage.stoppedBecause).toBe("aborted");
  });

  it("reports incomplete context and preserves malformed saved state", async () => {
    const f = await fixture();
    const path = join(
      f.runtime.env.HOME!,
      ".config",
      "skilloom",
      "inventory.json",
    );
    await writeFile(path, "{broken");
    expect(await doctor(["--installations"], f.runtime, false)).toBe(4);
    expect(f.output.at(-1)).toMatch(/incomplete/i);
    expect(f.output.at(-1)).not.toContain("PASS");
    expect(await readFile(path, "utf8")).toBe("{broken");
  });
});

describe("installation context deadlines", () => {
  it("rejects relative context roots before any filesystem reads", async () => {
    const f = await fixture("1.5.25", false);
    const read = vi.spyOn(filesystem, "readFile");
    const stat = vi.spyOn(filesystem, "lstat");
    f.runtime.env.XDG_CONFIG_HOME = "relative-config";
    await expect(inspectLocalInstallations(f.runtime)).rejects.toThrow(
      "XDG_CONFIG_HOME must be an absolute path",
    );
    expect(read).not.toHaveBeenCalled();
    expect(stat).not.toHaveBeenCalled();
    delete f.runtime.env.XDG_CONFIG_HOME;
    f.runtime.env.HOME = "relative-home";
    await expect(inspectLocalInstallations(f.runtime)).rejects.toThrow(
      "HOME or USERPROFILE must be an absolute path",
    );
    expect(read).not.toHaveBeenCalled();
  });

  it("cancels a pending context read and consumes its late rejection without more filesystem work", async () => {
    const f = await fixture("1.5.25", false);
    const controller = new AbortController();
    f.runtime.signal = controller.signal;
    let rejectRead!: (error: Error) => void;
    const read = vi.spyOn(filesystem, "readFile").mockReturnValueOnce(
      new Promise<never>((_resolve, reject) => {
        rejectRead = reject;
      }),
    );
    const stat = vi.spyOn(filesystem, "lstat");
    const pending = inspectLocalInstallations(f.runtime);
    expect(read).toHaveBeenCalledTimes(1);
    controller.abort();
    const report = await pending;
    expect(report.complete).toBe(false);
    expect(report.coverage.stoppedBecause).toBe("aborted");
    expect(report.coverage.roots).toEqual([]);
    expect(report.coverage.limitations.join(" ")).toMatch(/context/i);
    rejectRead(new Error("late read failure"));
    await Promise.resolve();
    expect(read).toHaveBeenCalledTimes(1);
    expect(stat).not.toHaveBeenCalled();
  });

  it("includes pending checkout ancestry reads in the same two-second budget", async () => {
    const f = await fixture("1.5.25", false);
    vi.spyOn(filesystem, "readFile").mockRejectedValue(
      Object.assign(new Error("absent"), { code: "ENOENT" }),
    );
    const stat = vi
      .spyOn(filesystem, "lstat")
      .mockReturnValue(new Promise<never>(() => {}));
    vi.useFakeTimers();
    const pending = inspectLocalInstallations(f.runtime);
    await vi.advanceTimersByTimeAsync(2000);
    const report = await pending;
    expect(stat).toHaveBeenCalledTimes(1);
    expect(report.complete).toBe(false);
    expect(report.coverage.stoppedBecause).toBe("time-limit");
    expect(report.coverage.roots).toEqual([]);
    expect(report.coverage.limitations.join(" ")).toMatch(/context/i);
  });

  it("does not read the policy locator or launch filesystem work after pre-cancellation", async () => {
    const f = await fixture("1.5.25", false);
    const controller = new AbortController();
    controller.abort();
    f.runtime.signal = controller.signal;
    const read = vi.spyOn(filesystem, "readFile");
    const stat = vi.spyOn(filesystem, "lstat");
    const report = await inspectLocalInstallations(
      f.runtime,
      join(f.runtime.cwd, "unused.yaml"),
    );
    expect(report.coverage.stoppedBecause).toBe("aborted");
    expect(read).not.toHaveBeenCalled();
    expect(stat).not.toHaveBeenCalled();
  });
});
