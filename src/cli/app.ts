import { defineCommand } from "citty";
import packageMetadata from "../../package.json" with { type: "json" };
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
import { showInventory } from "./inventory.js";
import { observeMachine } from "./observe.js";
import { editPolicy } from "./policy.js";
import { applyReconciliation, showReconciliation } from "./reconcile.js";
import { type CliRuntime, defaultRuntime } from "./runtime.js";
import { setupMachine } from "./setup.js";
import {
  applyWorkspacePlan,
  showWorkspacePlan,
} from "./workspace-reconcile.js";

export { type CliRuntime, defaultRuntime };

const version = packageMetadata.version;

const help = `Skilloom ${version}

Usage: skilloom <command> [options]

Commands:
  skilloom setup [DIR]      Discover projects and adopt existing skills
  skilloom inventory        Show machines, projects, skills, and drift
  skilloom add NAME...      Add desired policy atomically
  skilloom edit NAME        Edit desired policy atomically
  skilloom move NAME        Move desired policy atomically
  skilloom remove NAME      Remove desired policy atomically
  skilloom observe          Save or publish the current inventory
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

const commandHelp: Record<string, string> = {
  setup: `Usage: skilloom setup [WORKSPACE] [options]

Discover Git projects, inspect existing installations through the skills CLI, and adopt eligible skills without reinstalling them.

Options:
  --depth <1-8>             Maximum project discovery depth, default 3
  --machine-name <name>     Human-readable name for this machine
  --profile <name>          Assign an existing global profile
  --storage <mode>          local, external, or managed
  --repository <url>        Managed Git configuration repository
  --sync <url>              Shorthand for managed Git storage
  --no-adopt                Keep existing installations unmanaged
  --json                    Emit the complete setup inventory`,
  inventory: `Usage: skilloom inventory [--json]

Show configured machines and profiles plus this machine's discovered projects, installed skills, ownership, and drift.`,
  add: `Usage: skilloom add NAME... --source SOURCE --to profile:NAME|project:ID [options]

Options:
  --agent <name>            Target agent, default codex
  --agents <a,b>            Target several agents
  --json                    Emit the saved policy change`,
  edit: `Usage: skilloom edit NAME --in profile:NAME|project:ID [options]

Options:
  --source <source>         Replace the skill source
  --agents <a,b>            Replace target agents
  --json                    Emit the saved policy change`,
  move: `Usage: skilloom move NAME --from profile:NAME|project:ID --to profile:NAME|project:ID [--json]`,
  remove: `Usage: skilloom remove NAME --from profile:NAME|project:ID [--json]`,
  observe: `Usage: skilloom observe [--publish] [--json]

Refresh local installed state. Publishing requires managed Git storage and never applies changes.`,
  plan: `Usage: skilloom plan [--all] [--check] [--json]`,
  apply: `Usage: skilloom apply [--all] [--yes] [--json]`,
  update: `Usage: skilloom update [NAME] [--scope global|project] [--yes] [--json]`,
};

export const commandContract = defineCommand({
  meta: {
    name: "skilloom",
    version,
    description: "Reconcile Agent Skills through the skills CLI",
  },
  subCommands: Object.fromEntries(
    [
      "init",
      "setup",
      "inventory",
      "add",
      "edit",
      "move",
      "remove",
      "observe",
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
  const scopeValue = option(args, "--scope");
  if (scopeValue && scopeValue !== "global" && scopeValue !== "project") {
    throw new Error("--scope must be global or project");
  }
  const name = args[0] && !args[0].startsWith("--") ? args[0] : undefined;
  const scopes = scopeValue
    ? [scopeValue as "global" | "project"]
    : (["project", "global"] as const);
  const results = [];
  for (const scope of scopes) {
    results.push(
      await adapter.update(scope, root, runtime.env, name ? [name] : []),
    );
  }
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
    { scopes, skills: name ? [name] : [] },
    `Updated ${name || "installed skills"} in ${scopes.join(" and ")} scope.`,
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
        const { runDashboard } = await import("../tui/dashboard.js");
        return runDashboard(
          () => showInventoryForDashboard(runtime),
          (args) => runCli(args, runtime),
        );
      }
      runtime.stdout(help);
      return 0;
    }
    if (flag(rawArgs, "--help") || flag(rawArgs, "-h")) {
      runtime.stdout(commandHelp[rawArgs[0] ?? ""] ?? help);
      return 0;
    }
    const command = rawArgs[0];
    if (command === "init")
      return await initializeConfiguration(rawArgs.slice(1), runtime, json);
    if (command === "setup")
      return await setupMachine(rawArgs.slice(1), runtime, json);
    if (command === "inventory")
      return await showInventory(
        runtime,
        json,
        option(rawArgs.slice(1), "--config"),
      );
    if (
      command === "add" ||
      command === "edit" ||
      command === "move" ||
      command === "remove"
    ) {
      return await editPolicy(command, rawArgs.slice(1), runtime, json);
    }
    if (command === "observe")
      return await observeMachine(rawArgs.slice(1), runtime, json);
    if (command === "plan") {
      const args = rawArgs.slice(1);
      if (flag(args, "--all"))
        return await showWorkspacePlan("plan", args, runtime, json);
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
      if (flag(args, "--all"))
        return await showWorkspacePlan("status", args, runtime, json);
      return await showReconciliation(
        "status",
        { configPath: option(args, "--config"), json },
        runtime,
      );
    }
    if (command === "apply") {
      const args = rawArgs.slice(1);
      if (flag(args, "--all"))
        return await applyWorkspacePlan(args, runtime, json);
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

async function showInventoryForDashboard(
  runtime: CliRuntime,
): Promise<import("../core/types.js").MachineInventory> {
  const { loadCurrentInventory } = await import("./inventory.js");
  return loadCurrentInventory(runtime);
}
