import { defineCommand } from "citty";
import { GitExecutionError } from "../adapters/git.js";
import {
  redactProcessOutput,
  SkillsAdapter,
  SkillsExecutionError,
} from "../adapters/skills.js";
import {
  findProjectRoot,
  loadUserConfig,
  resolveConfigPaths,
} from "../core/config.js";
import {
  configureProfiles,
  editProject,
  initializeConfiguration,
  initializeProject,
} from "./configuration.js";
import { applyReconciliation, showReconciliation } from "./reconcile.js";
import { type CliRuntime, defaultRuntime } from "./runtime.js";

export { type CliRuntime, defaultRuntime };

const version = "1.0.0";

const help = `Skilloom ${version}

Usage: skilloom <command> [options]

Commands:
  skilloom init             Initialize user configuration
  skilloom plan             Show desired changes
  skilloom apply            Apply desired changes through npx skills
  skilloom status           Show convergence status
  skilloom update           Update managed skills
  skilloom project init     Create .skilloom.yaml
  skilloom project add      Add a project requirement
  skilloom project remove   Remove a project requirement
  skilloom config           Manage profiles and machine selection
  skilloom doctor           Diagnose the local setup

Common options:
  --json                    Emit machine-readable output
  --config <path>           Use an explicit user configuration
  --yes                     Confirm a mutating command
  --help                    Show command help
  --version                 Show the version`;

export const commandContract = defineCommand({
  meta: {
    name: "skilloom",
    version,
    description: "Reconcile Agent Skills through the skills CLI",
  },
  subCommands: Object.fromEntries(
    [
      "init",
      "plan",
      "apply",
      "status",
      "update",
      "project",
      "config",
      "doctor",
    ].map((name) => [name, defineCommand({ meta: { name } })]),
  ),
});

function flag(args: string[], name: string): boolean {
  return args.includes(name);
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--"))
    throw new Error(`${name} requires a value`);
  return value;
}

function emit(
  runtime: CliRuntime,
  json: boolean,
  command: string,
  data: Record<string, unknown>,
  text: string,
): void {
  runtime.stdout(json ? JSON.stringify({ ok: true, command, ...data }) : text);
}

function emitError(
  runtime: CliRuntime,
  json: boolean,
  code: string,
  message: string,
): void {
  runtime.stderr(
    json
      ? JSON.stringify({ ok: false, error: { code, message } })
      : `Error: ${message}`,
  );
}

async function update(
  args: string[],
  runtime: CliRuntime,
  json: boolean,
): Promise<number> {
  if (!flag(args, "--yes") && !runtime.isTTY) {
    emit(
      runtime,
      json,
      "update",
      { canceled: true },
      "Refusing to prompt outside a terminal. Pass --yes to update.",
    );
    return 5;
  }
  if (
    !flag(args, "--yes") &&
    !(await runtime.confirm("Update project and global skills?"))
  )
    return 5;
  const adapter = new SkillsAdapter(runtime.run);
  const root = findProjectRoot(runtime.cwd) || runtime.cwd;
  const results = [
    await adapter.update("project", root, runtime.env),
    await adapter.update("global", root, runtime.env),
  ];
  const failure = results.find((result) => result.code !== 0);
  if (failure)
    throw new SkillsExecutionError(
      redactProcessOutput(failure.stderr, runtime.env).trim() ||
        `skills update exited ${failure.code}`,
    );
  emit(
    runtime,
    json,
    "update",
    { scopes: ["project", "global"] },
    "Updated project and global skills.",
  );
  return 0;
}

async function doctor(
  args: string[],
  runtime: CliRuntime,
  json: boolean,
): Promise<number> {
  const paths = resolveConfigPaths(runtime.env, option(args, "--config"));
  const projectRoot = findProjectRoot(runtime.cwd);
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
  checks.push({
    name: "runtime",
    ok: true,
    detail: `${process.release.name} ${process.version}`,
  });
  for (const [name, executable, commandArgs] of [
    ["git", "git", ["--version"]],
    ["npx", "npx", ["--version"]],
    ["skills", "npx", ["skills", "--version"]],
  ] as const) {
    try {
      const result = await runtime.run(executable, [...commandArgs], {
        cwd: runtime.cwd,
        env: runtime.env,
      });
      checks.push({
        name,
        ok: result.code === 0,
        detail: (result.stdout || result.stderr).trim(),
      });
    } catch (error) {
      checks.push({ name, ok: false, detail: String(error) });
    }
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
            ? result.stderr.trim() || `git status exited ${result.code}`
            : changes === 0
              ? "clean"
              : `${changes} uncommitted change(s)`,
      });
    } catch (error) {
      checks.push({
        name: "repository",
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  } else {
    checks.push({ name: "repository", ok: true, detail: "not applicable" });
  }
  try {
    await loadUserConfig(paths.configPath);
    checks.push({ name: "config", ok: true, detail: paths.configPath });
  } catch (error) {
    checks.push({
      name: "config",
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }
  const ok = checks.every((check) => check.ok);
  emit(
    runtime,
    json,
    "doctor",
    { checks },
    checks
      .map(
        (check) =>
          `${check.ok ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`,
      )
      .join("\n"),
  );
  return ok ? 0 : 4;
}

export async function runCli(
  rawArgs: string[],
  runtime: CliRuntime,
): Promise<number> {
  const json = flag(rawArgs, "--json");
  try {
    if (flag(rawArgs, "--version") || flag(rawArgs, "-v")) {
      runtime.stdout(version);
      return 0;
    }
    if (rawArgs.length === 0) {
      if (runtime.isTTY) {
        const { runGuidedMenu } = await import("../tui/menu.js");
        return runGuidedMenu((args) => runCli(args, runtime));
      }
      runtime.stdout(help);
      return 0;
    }
    if (flag(rawArgs, "--help") || flag(rawArgs, "-h")) {
      runtime.stdout(help);
      return 0;
    }
    const command = rawArgs[0];
    if (command === "init")
      return await initializeConfiguration(rawArgs.slice(1), runtime, json);
    if (command === "plan") {
      const args = rawArgs.slice(1);
      return await showReconciliation(
        "plan",
        {
          configPath: option(args, "--config"),
          check: flag(args, "--check"),
          json,
        },
        runtime,
      );
    }
    if (command === "status") {
      const args = rawArgs.slice(1);
      return await showReconciliation(
        "status",
        { configPath: option(args, "--config"), json },
        runtime,
      );
    }
    if (command === "apply") {
      const args = rawArgs.slice(1);
      return await applyReconciliation(
        {
          configPath: option(args, "--config"),
          yes: flag(args, "--yes"),
          json,
        },
        runtime,
      );
    }
    if (command === "project" && rawArgs[1] === "init")
      return await initializeProject(rawArgs.slice(2), runtime, json);
    if (command === "project" && rawArgs[1] === "add")
      return await editProject("add", rawArgs.slice(2), runtime, json);
    if (command === "project" && rawArgs[1] === "remove")
      return await editProject("remove", rawArgs.slice(2), runtime, json);
    if (command === "config")
      return await configureProfiles(rawArgs.slice(1), runtime, json);
    if (command === "update")
      return await update(rawArgs.slice(1), runtime, json);
    if (command === "doctor")
      return await doctor(rawArgs.slice(1), runtime, json);
    throw new Error(`unknown command ${command || ""}`);
  } catch (error) {
    const executionFailure =
      error instanceof SkillsExecutionError ||
      error instanceof GitExecutionError;
    emitError(
      runtime,
      json,
      executionFailure ? "execution_failed" : "invalid_or_unavailable",
      error instanceof Error ? error.message : String(error),
    );
    return executionFailure ? 4 : 3;
  }
}
