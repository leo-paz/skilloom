import * as filesystem from "node:fs/promises";
import {
  mkdir,
  mkdtemp,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installationDiagnosticRoots } from "../src/adapters/installation-roots.js";
import { scanInstallationDiagnostics } from "../src/core/installation-diagnostics.js";

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
}));

const homes: string[] = [];
async function home() {
  const path = await mkdtemp(join(tmpdir(), "skilloom-diagnostics-"));
  homes.push(path);
  return path;
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    homes.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});
const identity = { machineId: "test-machine", machineName: "Test machine" };

describe("installation diagnostics", () => {
  it("observes missing links once through aliased parents, preserving raw targets and path aliases", async () => {
    const root = await home();
    const skills = join(root, ".openclaw", "skills");
    await mkdir(skills, { recursive: true });
    await symlink("../missing-review", join(skills, "review"));
    await symlink(".openclaw", join(root, ".clawdbot"));
    const report = await scanInstallationDiagnostics({
      ...identity,
      env: { HOME: root },
    });
    expect(report.complete).toBe(true);
    expect(report.entries).toHaveLength(1);
    expect(report.entries[0]).toMatchObject({
      name: "review",
      status: "target-missing",
      linkText: "../missing-review",
      targetPath: `${await realpath(skills)}${sep}../missing-review`,
      aliases: expect.arrayContaining([
        join(root, ".openclaw", "skills", "review"),
        join(root, ".clawdbot", "skills", "review"),
      ]),
    });
    expect(await readlink(join(skills, "review"))).toBe("../missing-review");
    const repeat = await scanInstallationDiagnostics({
      ...identity,
      env: { HOME: root },
    });
    expect(repeat.entries[0]?.id).toBe(report.entries[0]?.id);
    const other = await scanInstallationDiagnostics({
      ...identity,
      machineId: "other",
      env: { HOME: root },
    });
    expect(other.entries[0]?.id).not.toBe(report.entries[0]?.id);
  });

  it("distinguishes loops and non-directory link targets from missing targets and ignores namespace directories", async () => {
    const root = await home();
    const skills = join(root, ".agents", "skills");
    await mkdir(join(skills, "namespace", "nested"), { recursive: true });
    await mkdir(join(skills, ".system"), { recursive: true });
    await writeFile(join(skills, "README.md"), "metadata");
    await writeFile(join(root, "file"), "file");
    await symlink(join(root, "file"), join(skills, "not-a-directory"));
    await symlink("loop", join(skills, "loop"));
    await symlink("missing", join(skills, ".system", "ignored"));
    const report = await scanInstallationDiagnostics({
      ...identity,
      env: { HOME: root },
    });
    expect(report.entries.map((entry) => entry.status).sort()).toEqual([
      "not-directory",
      "symlink-loop",
    ]);
    expect(report.coverage.roots.some((item) => item.status === "absent")).toBe(
      true,
    );
    expect(report.coverage.limitations.join(" ")).toContain(
      "Immediate children",
    );
  });

  it("scans only explicit checkout roots and configured homes without recursively discovering projects", async () => {
    const root = await home();
    const checkout = join(root, "project");
    const custom = join(root, "custom-codex");
    for (const path of [
      join(custom, "skills"),
      join(checkout, ".claude", "skills"),
      join(checkout, "nested", ".claude", "skills"),
    ]) {
      await mkdir(path, { recursive: true });
      await symlink("missing", join(path, "review"));
    }
    const report = await scanInstallationDiagnostics({
      ...identity,
      env: { HOME: root, CODEX_HOME: custom },
      projectRoots: [checkout],
    });
    expect(report.entries).toHaveLength(2);
    expect(report.entries.map((entry) => entry.scope).sort()).toEqual([
      "global",
      "project",
    ]);
    expect(report.entries.some((entry) => entry.path.includes("nested"))).toBe(
      false,
    );
  });

  it("reports entry/root bounds and cancellation as partial coverage", async () => {
    const root = await home();
    const skills = join(root, ".agents", "skills");
    await mkdir(skills, { recursive: true });
    for (const name of ["one", "two", "three"])
      await symlink("missing", join(skills, name));
    const limited = await scanInstallationDiagnostics({
      ...identity,
      env: { HOME: root },
      maxEntries: 2,
    });
    expect(limited.complete).toBe(false);
    expect(limited.coverage.entriesChecked).toBe(2);
    expect(limited.coverage.stoppedBecause).toBe("entry-limit");
    expect(limited.entries).toHaveLength(2);
    const roots = await scanInstallationDiagnostics({
      ...identity,
      env: { HOME: root },
      maxRoots: 1,
    });
    expect(roots.coverage.stoppedBecause).toBe("root-limit");
    const controller = new AbortController();
    controller.abort();
    const cancelled = await scanInstallationDiagnostics({
      ...identity,
      env: { HOME: root },
      signal: controller.signal,
    });
    expect(cancelled.coverage.stoppedBecause).toBe("aborted");
    expect(cancelled.complete).toBe(false);
  });

  it("distinguishes a non-directory root from an absent root and never guesses a missing injected home", async () => {
    const root = await home();
    await mkdir(join(root, ".agents"));
    await writeFile(join(root, ".agents", "skills"), "file");
    const report = await scanInstallationDiagnostics({
      ...identity,
      env: { HOME: root },
    });
    expect(report.complete).toBe(false);
    expect(
      report.coverage.roots.find(
        (item) => item.path === join(root, ".agents", "skills"),
      )?.status,
    ).toBe("not-directory");
    await expect(
      scanInstallationDiagnostics({ ...identity, env: {} }),
    ).rejects.toThrow("absolute home");
  });

  it("reports a dangling root as missing rather than absent", async () => {
    const root = await home();
    await mkdir(join(root, ".agents"));
    await symlink("missing-root", join(root, ".agents", "skills"));
    const report = await scanInstallationDiagnostics({
      ...identity,
      env: { HOME: root },
    });
    expect(report.complete).toBe(false);
    expect(
      report.coverage.roots.find(
        (item) => item.path === join(root, ".agents", "skills"),
      )?.status,
    ).toBe("target-missing");
  });

  it("reports unreadable entries and roots without confusing access failure with missing targets", async () => {
    const root = await home();
    const skills = join(root, ".agents", "skills");
    await mkdir(skills, { recursive: true });
    await symlink("missing", join(skills, "review"));
    const original = filesystem.lstat;
    vi.spyOn(filesystem, "lstat").mockImplementation(((
      path: Parameters<typeof original>[0],
      ...args: unknown[]
    ) => {
      if (
        String(path) === join(skills, "review") ||
        String(path) === join(root, ".claude", "skills")
      )
        return Promise.reject(
          Object.assign(new Error("Denied"), { code: "EACCES" }),
        );
      return original(path, ...(args as []));
    }) as typeof original);
    const report = await scanInstallationDiagnostics({
      ...identity,
      env: { HOME: root },
    });
    expect(report.complete).toBe(false);
    expect(report.entries[0]).toMatchObject({
      status: "unreadable",
      errorCode: "EACCES",
    });
    expect(
      report.coverage.roots.find(
        (item) => item.path === join(root, ".claude", "skills"),
      ),
    ).toMatchObject({ status: "unreadable", errorCode: "EACCES" });
  });

  it("returns on its deadline and closes an opendir that completes after the cutoff", async () => {
    const root = await home();
    const skills = join(root, ".agents", "skills");
    await mkdir(skills, { recursive: true });
    const directory = await filesystem.opendir(skills);
    const close = vi.spyOn(directory, "close");
    let finish: ((value: typeof directory) => void) | undefined;
    vi.spyOn(filesystem, "opendir").mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const report = await scanInstallationDiagnostics({
      ...identity,
      env: { HOME: root },
      maxDurationMs: 40,
    });
    expect(report.complete).toBe(false);
    expect(report.coverage.stoppedBecause).toBe("time-limit");
    expect(close).not.toHaveBeenCalled();
    finish?.(directory);
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce());
  });

  it("cancels a pending filesystem read without waiting for it to return", async () => {
    const root = await home();
    vi.spyOn(filesystem, "lstat").mockImplementation(
      () => new Promise(() => {}),
    );
    const controller = new AbortController();
    const pending = scanInstallationDiagnostics({
      ...identity,
      env: { HOME: root },
      signal: controller.signal,
    });
    controller.abort();
    const report = await pending;
    expect(report.complete).toBe(false);
    expect(report.coverage.stoppedBecause).toBe("aborted");
  });

  it("records relative overrides as invalid roots without inspecting cwd", async () => {
    const root = await home();
    const report = await scanInstallationDiagnostics({
      ...identity,
      env: { HOME: root, CODEX_HOME: "relative-codex" },
    });
    expect(report.complete).toBe(false);
    expect(report.coverage.roots).toContainEqual(
      expect.objectContaining({
        path: join("relative-codex", "skills"),
        status: "unreadable",
        errorCode: "INVALID_ROOT",
      }),
    );
  });

  it("reports dangling SKILL.md links inside direct and linked directories without calling the skill directory missing", async () => {
    const root = await home();
    const skills = join(root, ".agents", "skills");
    const direct = join(skills, "direct");
    const target = join(root, "linked-target");
    const linked = join(skills, "linked");
    await mkdir(direct, { recursive: true });
    await mkdir(target);
    await symlink("missing-instructions.md", join(direct, "SKILL.md"));
    await symlink("missing-instructions.md", join(target, "SKILL.md"));
    await symlink(target, linked);
    const report = await scanInstallationDiagnostics({
      ...identity,
      env: { HOME: root },
    });
    expect(report.entries).toHaveLength(2);
    for (const path of [direct, linked]) {
      const entry = report.entries.find((entry) => entry.path === path);
      expect(entry).toMatchObject({
        status: "skill-file-invalid",
        errorCode: "ENOENT",
        skillFile: {
          path: join(path, "SKILL.md"),
          linkText: "missing-instructions.md",
          targetPath: join(await realpath(path), "missing-instructions.md"),
        },
      });
    }
    expect(
      report.entries.find((entry) => entry.path === direct)?.linkText,
    ).toBeUndefined();
    expect(
      report.entries.find((entry) => entry.path === linked)?.linkText,
    ).toBe(target);
  });

  it("preserves dot-dot after symlink pivots rather than inventing a normalized target", async () => {
    const root = await home();
    const skills = join(root, ".agents", "skills");
    const storage = join(root, "storage");
    await mkdir(join(skills, "missing"), { recursive: true });
    await mkdir(join(storage, "nested"), { recursive: true });
    await symlink(join(storage, "nested"), join(skills, "pivot"));
    await symlink("pivot/../missing", join(skills, "review"));
    const report = await scanInstallationDiagnostics({
      ...identity,
      env: { HOME: root },
    });
    expect(report.entries).toHaveLength(1);
    expect(report.entries[0]).toMatchObject({
      name: "review",
      status: "target-missing",
      linkText: "pivot/../missing",
      targetPath: `${await realpath(skills)}${sep}pivot/../missing`,
    });
    expect(report.entries[0]?.targetPath).not.toBe(
      join(await realpath(skills), "missing"),
    );
    expect(report.entries[0]?.missingTargetPath).toBe(
      join(await realpath(storage), "missing"),
    );
  });

  it("groups distinct link expressions only when an existing resolved parent proves the same missing leaf", async () => {
    const root = await home();
    const shared = join(root, "shared");
    await mkdir(shared);
    for (const agent of [".agents", ".claude"]) {
      const skills = join(root, agent, "skills");
      await mkdir(skills, { recursive: true });
      await symlink("../../shared/missing", join(skills, "review"));
    }
    await symlink(
      "../../absent-parent/missing",
      join(root, ".agents", "skills", "unresolved"),
    );
    await symlink(join(shared, "missing"), join(shared, "chain"));
    await symlink(
      "../../shared/chain",
      join(root, ".agents", "skills", "chain"),
    );
    await symlink(
      "../../shared/chain/",
      join(root, ".agents", "skills", "chain-trailing"),
    );
    const report = await scanInstallationDiagnostics({
      ...identity,
      env: { HOME: root },
    });
    const reviews = report.entries.filter((entry) => entry.name === "review");
    expect(reviews).toHaveLength(2);
    expect(reviews[0]?.targetPath).not.toBe(reviews[1]?.targetPath);
    for (const entry of reviews)
      expect(entry.missingTargetPath).toBe(
        join(await realpath(shared), "missing"),
      );
    expect(
      report.entries.find((entry) => entry.name === "unresolved")
        ?.missingTargetPath,
    ).toBeUndefined();
    expect(
      report.entries.find((entry) => entry.name === "chain")?.missingTargetPath,
    ).toBeUndefined();
    expect(
      report.entries.find((entry) => entry.name === "chain-trailing")
        ?.missingTargetPath,
    ).toBeUndefined();
    expect(
      report.entries.find((entry) => entry.name === "chain-trailing")?.status,
    ).toBe("target-missing");
  });

  it("derives Windows paths with native home and configured-root semantics without claiming Windows mutation support", () => {
    const roots = [
      ...installationDiagnosticRoots(
        { USERPROFILE: "C:\\Users\\test", CODEX_HOME: "D:\\codex" },
        ["D:\\repo"],
        "win32",
      ),
    ];
    expect(roots).toContainEqual({
      path: "D:\\codex\\skills",
      scope: "global",
    });
    expect(roots).toContainEqual({
      path: "D:\\repo\\.claude\\skills",
      scope: "project",
    });
    expect(roots.some((root) => root.path.startsWith("/Users/"))).toBe(false);
  });
});
