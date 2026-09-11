import { lstat, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { hostname } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import packageMetadata from "../../package.json" with { type: "json" };
import { redactProcessOutput } from "../adapters/skills.js";
import {
  findProjectRoot,
  loadInventorySnapshot,
  loadLocalMachine,
  loadUserConfig,
  resolveConfigPaths,
} from "../core/config.js";
import {
  type InstallationDiagnosticsReport,
  scanInstallationDiagnostics,
} from "../core/installation-diagnostics.js";
import type { MachineInventory } from "../core/types.js";
import type { CliRuntime } from "./runtime.js";

class InstallationContextStopped extends Error {
  constructor(readonly reason: "aborted" | "time-limit") {
    super(reason);
  }
}

/** Read local installation context without initializing, publishing, or discovering projects. */
export async function inspectLocalInstallations(
  runtime: CliRuntime,
  _configPath?: string,
  inventory?: MachineInventory,
): Promise<InstallationDiagnosticsReport> {
  const started = performance.now();
  const observedAt = new Date().toISOString();
  const maxDurationMs = 2_000;
  const check = () => {
    if (runtime.signal?.aborted)
      throw new InstallationContextStopped("aborted");
    if (performance.now() - started >= maxDurationMs)
      throw new InstallationContextStopped("time-limit");
  };
  async function contextRead<T>(operation: () => Promise<T>): Promise<T> {
    check();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    const pending = operation();
    void pending.catch(() => {});
    try {
      return await Promise.race([
        pending,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new InstallationContextStopped("time-limit")),
            Math.max(1, maxDurationMs - (performance.now() - started)),
          );
          abort = () => reject(new InstallationContextStopped("aborted"));
          runtime.signal?.addEventListener("abort", abort, { once: true });
          if (runtime.signal?.aborted) abort();
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      if (abort) runtime.signal?.removeEventListener("abort", abort);
    }
  }
  const env: NodeJS.ProcessEnv = {
    ...runtime.env,
    HOME: runtime.env.HOME || runtime.env.USERPROFILE,
  };
  const limitations: string[] = [];
  const issue = (message: string, error?: unknown) => {
    limitations.push(
      redactProcessOutput(
        `${message}${error ? `: ${error instanceof Error ? error.message : String(error)}` : ""}`,
        env,
      ),
    );
  };
  if (!env.HOME || !isAbsolute(env.HOME))
    throw new Error(
      "HOME or USERPROFILE must be an absolute path for installation checks",
    );
  if (env.XDG_CONFIG_HOME && !isAbsolute(env.XDG_CONFIG_HOME))
    throw new Error(
      "XDG_CONFIG_HOME must be an absolute path for installation checks",
    );
  // Local identity and inventory do not depend on the shared policy locator.
  const appDir = env.HOME
    ? join(env.XDG_CONFIG_HOME || join(env.HOME, ".config"), "skilloom")
    : undefined;
  const paths = appDir
    ? {
        machineIdPath: join(appDir, "machine-id"),
        machinePath: join(appDir, "machine.json"),
        inventoryPath: join(appDir, "inventory.json"),
      }
    : undefined;
  let machineId: string | null = null;
  let machineName = hostname();
  let identityConsistent = true;
  try {
    check();
    if (paths) {
      try {
        const id = (
          await contextRead(() => readFile(paths.machineIdPath, "utf8"))
        ).trim();
        if (!/^[a-f0-9-]{36}$/.test(id))
          throw new Error("Invalid local machine identifier");
        machineId = id;
      } catch (error) {
        if (error instanceof InstallationContextStopped) throw error;
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          issue("Local machine identity could not be read", error);
          identityConsistent = false;
        }
      }
      try {
        // Missing setup is valid. Never call ensureMachineId or initializeConfiguration here.
        await contextRead(() => readFile(paths.machinePath, "utf8"));
        const machine = await contextRead(() =>
          loadLocalMachine(paths.machinePath),
        );
        if (machineId && machine.id !== machineId) {
          issue(
            "Local machine records disagree; saved checkout paths were not checked",
          );
          identityConsistent = false;
        } else if (machineId) {
          machineName = machine.name;
        }
      } catch (error) {
        if (error instanceof InstallationContextStopped) throw error;
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          issue("Local machine configuration could not be read", error);
          identityConsistent = false;
        }
      }
      if (!inventory) {
        try {
          inventory = await contextRead(() =>
            loadInventorySnapshot(paths.inventoryPath),
          );
        } catch (error) {
          if (error instanceof InstallationContextStopped) throw error;
          issue(
            "Saved inventory could not be read; saved checkout paths were not checked",
            error,
          );
        }
      }
    }
    const projectRoots: string[] = [];
    if (inventory) {
      if (
        !machineId ||
        !identityConsistent ||
        inventory.machine?.id !== machineId
      ) {
        issue(
          "Saved inventory machine identity is unavailable or does not match this machine; its checkout paths were not checked",
        );
      } else {
        for (const project of inventory.projects) {
          check();
          if (!Array.isArray(project?.checkouts)) {
            issue(
              "Saved inventory contains invalid checkout records; those paths were not checked",
            );
            continue;
          }
          for (const checkout of project.checkouts) {
            check();
            if (typeof checkout?.path === "string" && isAbsolute(checkout.path))
              projectRoots.push(checkout.path);
            else
              issue(
                "Saved inventory contains a checkout without an absolute local path; it was not checked",
              );
          }
        }
      }
    }
    // Unlike existsSync, lstat distinguishes inaccessible ancestry from no Git checkout.
    let current = resolve(runtime.cwd);
    while (true) {
      try {
        await contextRead(() => lstat(join(current, ".git")));
        projectRoots.push(current);
        break;
      } catch (error) {
        if (error instanceof InstallationContextStopped) throw error;
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          issue("Current checkout context could not be fully checked", error);
          break;
        }
      }
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
    check();
    const report = await scanInstallationDiagnostics({
      machineId,
      machineName,
      env,
      projectRoots: [...new Set(projectRoots)],
      maxDurationMs: Math.max(1, maxDurationMs - (performance.now() - started)),
      ...(runtime.signal ? { signal: runtime.signal } : {}),
    });
    if (limitations.length) {
      report.complete = false;
      report.coverage.limitations.push(...limitations);
    }
    if (!machineId)
      report.coverage.limitations.push(
        "Skilloom machine identity is not initialized; this report describes the current computer only.",
      );
    report.coverage.limits.maxDurationMs = maxDurationMs;
    return report;
  } catch (error) {
    if (!(error instanceof InstallationContextStopped)) throw error;
    return {
      schemaVersion: 1,
      machineId,
      machineName,
      platform: process.platform,
      observedAt,
      complete: false,
      entries: [],
      coverage: {
        roots: [],
        entriesChecked: 0,
        limits: { maxEntries: 5000, maxRoots: 10000, maxDurationMs },
        stoppedBecause: error.reason,
        limitations: [
          ...limitations,
          `Installation context ${error.reason === "aborted" ? "was cancelled" : "reached its two-second deadline"}; installation roots were not checked. A pending operating-system read may finish after this report returns.`,
        ],
      },
    };
  }
}

function formatInstallationDiagnostics(
  report: InstallationDiagnosticsReport,
): string {
  const names: Record<string, string> = {
    "target-missing": "Target missing",
    unreadable: "Cannot read",
    "symlink-loop": "Link loop",
    "not-directory": "Not a directory",
    "skill-file-invalid": "SKILL.md is not a regular file",
    "changed-during-scan": "Changed during check",
  };
  const quote = (value: string) => JSON.stringify(value);
  const lines = [
    `Installation checks — ${quote(report.machineName)} (this computer only)`,
    `${report.complete ? "Completed within the listed roots" : "Incomplete check"} · ${report.entries.length} finding(s) · ${report.coverage.entriesChecked} entries checked`,
    `Observed ${report.observedAt} · ${report.platform}`,
    `Machine identity: ${report.machineId || "not initialized"}`,
  ];
  for (const entry of report.entries) {
    lines.push(`${names[entry.status] || entry.status}: ${quote(entry.path)}`);
    if (entry.targetPath)
      lines.push(`  Link target: ${quote(entry.targetPath)}`);
    if (entry.skillFile) {
      lines.push(`  Skill file: ${quote(entry.skillFile.path)}`);
      if (entry.skillFile.targetPath)
        lines.push(
          `  Skill file link target: ${quote(entry.skillFile.targetPath)}`,
        );
    }
    if (entry.errorCode) lines.push(`  Filesystem result: ${entry.errorCode}`);
    for (const alias of entry.aliases)
      if (alias !== entry.path)
        lines.push(`  Also reached through: ${quote(alias)}`);
  }
  lines.push("Root coverage:");
  for (const root of report.coverage.roots) {
    lines.push(
      `  ${root.status}: ${quote(root.path)}${root.errorCode ? ` (${root.errorCode})` : ""}`,
    );
  }
  if (report.coverage.stoppedBecause)
    lines.push(`Stopped: ${report.coverage.stoppedBecause}`);
  for (const limitation of report.coverage.limitations)
    lines.push(`Scope: ${limitation}`);
  lines.push(
    "Read-only observations. No installations or configuration changed.",
  );
  return lines.join("\n");
}

interface Diagnostic {
  name: string;
  ok: boolean;
  detail: string;
}
export function inspectRuntime(
  nodeVersion = process.versions.node,
  bunVersion = process.versions.bun,
): Diagnostic {
  const major = Number(nodeVersion.split(".")[0]);
  return {
    name: "runtime",
    ok: Number.isInteger(major) && major >= 20,
    detail: `${bunVersion ? `Bun ${bunVersion} (Node compatibility ${nodeVersion})` : `Node ${nodeVersion}`} · requires Node >=20 · ${process.execPath}`,
  };
}
const require = createRequire(import.meta.url);
export async function doctor(
  args: string[],
  runtime: CliRuntime,
  json: boolean,
): Promise<number> {
  const index = args.indexOf("--config");
  const explicit = index < 0 ? undefined : args[index + 1];
  if (index >= 0 && (!explicit || explicit.startsWith("--")))
    throw new Error("--config requires a value");
  if (args.includes("--installations")) {
    const installations = await inspectLocalInstallations(runtime, explicit);
    runtime.stdout(
      json
        ? JSON.stringify({
            ok: installations.complete,
            command: "doctor",
            installations,
          })
        : formatInstallationDiagnostics(installations),
    );
    return installations.complete ? 0 : 4;
  }
  const paths = resolveConfigPaths(runtime.env, explicit);
  const projectRoot = findProjectRoot(runtime.cwd);
  const checks: Diagnostic[] = [inspectRuntime()];
  const detail = (value: unknown) =>
    redactProcessOutput(
      value instanceof Error ? value.message : String(value),
      runtime.env,
    );
  try {
    const result = await runtime.run("git", ["--version"], {
      cwd: runtime.cwd,
      env: runtime.env,
    });
    checks.push({
      name: "git",
      ok: result.code === 0,
      detail: detail(
        (result.stdout || result.stderr).trim() || `git exited ${result.code}`,
      ),
    });
  } catch (error) {
    checks.push({ name: "git", ok: false, detail: detail(error) });
  }
  try {
    // Resolve beside Skilloom, exactly as SkillsAdapter does; never fetch a different package.
    const metadataPath = require.resolve("skills/package.json");
    const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as {
      version?: unknown;
    };
    const expected = packageMetadata.dependencies.skills;
    if (metadata.version !== expected)
      throw new Error(
        `Installed skills dependency is ${String(metadata.version)}; Skilloom requires pinned ${expected}. Reinstall Skilloom to repair its dependency.`,
      );
    const executable = join(dirname(metadataPath), "bin", "cli.mjs");
    const result = await runtime.run(
      process.execPath,
      [executable, "--version"],
      { cwd: runtime.cwd, env: runtime.env },
    );
    const observed = result.stdout.trim();
    checks.push({
      name: "skills",
      ok: result.code === 0 && observed === expected,
      detail:
        result.code === 0
          ? detail(
              `Pinned ${expected}; executable reported ${observed || "no version"}`,
            )
          : detail(
              result.stderr.trim() ||
                `Pinned skills ${expected} exited ${result.code}`,
            ),
    });
  } catch (error) {
    checks.push({ name: "skills", ok: false, detail: detail(error) });
  }
  checks.push({
    name: "project",
    ok: true,
    detail: projectRoot || "No Git repository found",
  });
  if (projectRoot) {
    try {
      const result = await runtime.run("git", ["status", "--porcelain"], {
        cwd: projectRoot,
        env: runtime.env,
      });
      const changes = result.stdout.trim().split("\n").filter(Boolean).length;
      checks.push({
        name: "repository",
        ok: result.code === 0,
        detail:
          result.code !== 0
            ? detail(result.stderr.trim() || `git status exited ${result.code}`)
            : changes === 0
              ? "clean"
              : `${changes} uncommitted change(s)`,
      });
    } catch (error) {
      checks.push({ name: "repository", ok: false, detail: detail(error) });
    }
  } else
    checks.push({ name: "repository", ok: true, detail: "not applicable" });
  try {
    await loadUserConfig(paths.configPath);
    checks.push({ name: "config", ok: true, detail: paths.configPath });
  } catch (error) {
    checks.push({ name: "config", ok: false, detail: detail(error) });
  }
  const ok = checks.every((check) => check.ok);
  runtime.stdout(
    json
      ? JSON.stringify({ ok, command: "doctor", checks })
      : checks
          .map(
            (check) =>
              `${check.ok ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`,
          )
          .join("\n"),
  );
  return ok ? 0 : 4;
}
