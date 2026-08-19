import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { defineCommand } from "citty";
import { GitAdapter } from "../adapters/git.js";
import {
  type ProcessRunner,
  runProcess,
  SkillsAdapter,
} from "../adapters/skills.js";
import {
  ensureMachineId,
  findProjectRoot,
  loadManagedState,
  loadProjectConfig,
  loadUserConfig,
  resolveConfigPaths,
  saveManagedState,
  saveProjectConfig,
  saveUserConfig,
  writeLocator,
} from "../core/config.js";
import { planChanges } from "../core/plan.js";
import { resolveDesiredState } from "../core/resolve.js";
import type { PlanOperation, UserConfig } from "../core/types.js";

export interface CliRuntime {
  cwd: string;
  env: NodeJS.ProcessEnv;
  isTTY: boolean;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  run: ProcessRunner;
  confirm: (message: string) => Promise<boolean>;
}

const help = `Skilloom 0.1.0

Usage: skilloom <command> [options]

Commands:
  skilloom init             Initialize user configuration
  skilloom plan             Show desired changes
  skilloom apply            Apply desired changes through npx skills
  skilloom status           Show convergence status
  skilloom update           Update managed skills
  skilloom project init     Create .skilloom.yaml
  skilloom config           Show or edit machine configuration
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
    version: "0.1.0",
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

function operationJson(operation: PlanOperation): Record<string, unknown> {
  return {
    kind: operation.kind,
    scope: operation.skill.scope,
    name: operation.skill.name,
    source: operation.skill.source,
    agents: operation.skill.agents,
    reasons: operation.reasons,
  };
}

function operationText(operation: PlanOperation): string {
  const agents = operation.skill.agents.join(", ") || "all agents";
  return `${operation.kind.toUpperCase()} ${operation.skill.scope} ${operation.skill.name} for ${agents}`;
}

async function maybePullManaged(
  config: UserConfig,
  configPath: string,
): Promise<UserConfig> {
  if (config.storage.mode !== "managed") return config;
  await new GitAdapter().pull(dirname(configPath));
  return loadUserConfig(configPath);
}

async function buildPlan(
  runtime: CliRuntime,
  explicitPath?: string,
): Promise<{
  operations: PlanOperation[];
  managed: Set<string>;
  statePath: string;
  cwd: string;
}> {
  const paths = resolveConfigPaths(runtime.env, explicitPath);
  const machineId = await ensureMachineId(paths.machineIdPath);
  let config = await loadUserConfig(paths.configPath);
  config = await maybePullManaged(config, paths.configPath);
  const projectRoot = findProjectRoot(runtime.cwd);
  const manifest = projectRoot
    ? await loadProjectConfig(join(projectRoot, ".skilloom.yaml"))
    : undefined;
  const desired = resolveDesiredState(config, machineId, projectRoot, manifest);
  const adapter = new SkillsAdapter(runtime.run);
  const global = await adapter.list(
    "global",
    projectRoot || runtime.cwd,
    runtime.env,
  );
  const project = projectRoot
    ? await adapter.list("project", projectRoot, runtime.env)
    : [];
  const managed = await loadManagedState(paths.statePath);
  return {
    operations: planChanges(desired, [...global, ...project], managed),
    managed,
    statePath: paths.statePath,
    cwd: projectRoot || runtime.cwd,
  };
}

async function initialize(
  args: string[],
  runtime: CliRuntime,
  json: boolean,
): Promise<number> {
  const storage = option(args, "--storage") || "local";
  if (!(["local", "external", "managed"] as string[]).includes(storage)) {
    throw new Error(`unknown storage mode ${storage}`);
  }
  const basePaths = resolveConfigPaths(runtime.env, option(args, "--config"));
  let configPath = basePaths.configPath;
  let repository: string | undefined;
  if (storage === "external") {
    configPath = resolve(
      option(args, "--path") ||
        (() => {
          throw new Error("external storage requires --path");
        })(),
    );
    await writeLocator(basePaths.locatorPath, configPath);
  }
  if (storage === "managed") {
    repository = option(args, "--repository");
    if (!repository) throw new Error("managed storage requires --repository");
    const checkout = join(basePaths.appDir, "repository");
    if (!existsSync(checkout))
      await new GitAdapter().clone(repository, checkout);
    configPath = join(checkout, "config.yaml");
    await writeLocator(basePaths.locatorPath, configPath);
  }
  if (existsSync(configPath) && !flag(args, "--force"))
    throw new Error(`configuration already exists at ${configPath}`);
  const machineId = await ensureMachineId(basePaths.machineIdPath);
  const config: UserConfig = {
    version: 1,
    storage: {
      mode: storage as "local" | "external" | "managed",
      ...(storage === "external" ? { path: configPath } : {}),
      ...(repository ? { repository } : {}),
    },
    profiles: { default: { skills: [] } },
    machines: { [machineId]: { profile: "default" } },
    projectProfiles: {},
    projects: {},
  };
  await saveUserConfig(configPath, config);
  if (storage === "managed")
    await new GitAdapter().commitAndPush(
      dirname(configPath),
      "Initialize Skilloom configuration",
    );
  emit(
    runtime,
    json,
    "init",
    { configPath, machineId, storage },
    `Initialized ${configPath}`,
  );
  return 0;
}

async function showPlan(
  args: string[],
  runtime: CliRuntime,
  json: boolean,
  command: "plan" | "status",
): Promise<number> {
  const result = await buildPlan(runtime, option(args, "--config"));
  const operations = result.operations.map(operationJson);
  const converged = operations.length === 0;
  emit(
    runtime,
    json,
    command,
    { converged, operations },
    converged
      ? "Skilloom is converged."
      : result.operations.map(operationText).join("\n"),
  );
  return command === "plan" && flag(args, "--check") && !converged ? 2 : 0;
}

async function apply(
  args: string[],
  runtime: CliRuntime,
  json: boolean,
): Promise<number> {
  const result = await buildPlan(runtime, option(args, "--config"));
  if (result.operations.length === 0) {
    emit(
      runtime,
      json,
      "apply",
      { completed: [], pending: [], converged: true },
      "No changes to apply.",
    );
    return 0;
  }
  if (
    !flag(args, "--yes") &&
    !(await runtime.confirm(`Apply ${result.operations.length} operation(s)?`))
  ) {
    emit(
      runtime,
      json,
      "apply",
      {
        completed: [],
        pending: result.operations.map(operationJson),
        canceled: true,
      },
      "Canceled. No changes made.",
    );
    return 5;
  }
  const adapter = new SkillsAdapter(runtime.run);
  const completed: PlanOperation[] = [];
  for (let index = 0; index < result.operations.length; index += 1) {
    const operation = result.operations[index];
    if (!operation) continue;
    const execution = await adapter.execute(operation, result.cwd, runtime.env);
    if (execution.code !== 0) {
      const pending = result.operations.slice(index);
      const payload = {
        ok: false,
        error: {
          code: "execution_failed",
          message: execution.stderr.trim() || `npx exited ${execution.code}`,
        },
        completed: completed.map(operationJson),
        pending: pending.map(operationJson),
      };
      runtime.stderr(
        json
          ? JSON.stringify(payload)
          : `Apply stopped: ${payload.error.message}`,
      );
      return 4;
    }
    completed.push(operation);
    const key = `${operation.skill.scope}:${operation.skill.name}`;
    if (operation.kind === "add") result.managed.add(key);
    else result.managed.delete(key);
    await saveManagedState(result.statePath, result.managed);
  }
  emit(
    runtime,
    json,
    "apply",
    { completed: completed.map(operationJson), pending: [], converged: true },
    `Applied ${completed.length} operation(s).`,
  );
  return 0;
}

async function projectInit(
  args: string[],
  runtime: CliRuntime,
  json: boolean,
): Promise<number> {
  const root = findProjectRoot(runtime.cwd);
  if (!root) throw new Error("project init must run inside a Git repository");
  const path = join(root, ".skilloom.yaml");
  if (existsSync(path) && !flag(args, "--force"))
    throw new Error(`${path} already exists`);
  await saveProjectConfig(path, { version: 1, skills: [] });
  emit(runtime, json, "project init", { path }, `Created ${path}`);
  return 0;
}

async function configure(
  args: string[],
  runtime: CliRuntime,
  json: boolean,
): Promise<number> {
  const paths = resolveConfigPaths(runtime.env, option(args, "--config"));
  const machineId = await ensureMachineId(paths.machineIdPath);
  const config = await loadUserConfig(paths.configPath);
  const profile = option(args, "--profile");
  if (profile) {
    if (!config.profiles[profile])
      throw new Error(`profile ${profile} does not exist`);
    config.machines[machineId] = { profile };
    await saveUserConfig(paths.configPath, config);
    if (config.storage.mode === "managed") {
      await new GitAdapter().commitAndPush(
        dirname(paths.configPath),
        `Assign machine ${machineId}`,
      );
    }
  }
  emit(
    runtime,
    json,
    "config",
    {
      configPath: paths.configPath,
      machineId,
      profile: config.machines[machineId]?.profile,
    },
    `${paths.configPath}\nMachine ${machineId}: ${config.machines[machineId]?.profile || "unassigned"}`,
  );
  return 0;
}

async function update(
  args: string[],
  runtime: CliRuntime,
  json: boolean,
): Promise<number> {
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
    throw new Error(
      failure.stderr.trim() || `skills update exited ${failure.code}`,
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
      runtime.stdout("0.1.0");
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
      return await initialize(rawArgs.slice(1), runtime, json);
    if (command === "plan")
      return await showPlan(rawArgs.slice(1), runtime, json, "plan");
    if (command === "status")
      return await showPlan(rawArgs.slice(1), runtime, json, "status");
    if (command === "apply")
      return await apply(rawArgs.slice(1), runtime, json);
    if (command === "project" && rawArgs[1] === "init")
      return await projectInit(rawArgs.slice(2), runtime, json);
    if (command === "config")
      return await configure(rawArgs.slice(1), runtime, json);
    if (command === "update")
      return await update(rawArgs.slice(1), runtime, json);
    if (command === "doctor")
      return await doctor(rawArgs.slice(1), runtime, json);
    throw new Error(`unknown command ${command || ""}`);
  } catch (error) {
    emitError(
      runtime,
      json,
      "invalid_or_unavailable",
      error instanceof Error ? error.message : String(error),
    );
    return 3;
  }
}

export function defaultRuntime(): CliRuntime {
  return {
    cwd: process.cwd(),
    env: process.env,
    isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
    run: runProcess,
    confirm: async (message) => {
      const { confirm, isCancel } = await import("@clack/prompts");
      const answer = await confirm({ message, initialValue: false });
      return !isCancel(answer) && answer;
    },
  };
}
