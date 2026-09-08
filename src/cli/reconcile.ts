import { dirname, join } from "node:path";
import { GitAdapter } from "../adapters/git.js";
import {
  inspectProjectSkills,
  protectRepositorySkills,
} from "../adapters/project.js";
import {
  commandForOperation,
  redactProcessOutput,
  SkillsAdapter,
} from "../adapters/skills.js";
import {
  findProjectRoot,
  loadMachineId,
  loadManagedState,
  loadProjectConfig,
  loadUserConfig,
  resolveConfigPaths,
  saveManagedState,
} from "../core/config.js";
import { managedStateKey, planChanges } from "../core/plan.js";
import { resolveDesiredState } from "../core/resolve.js";
import type { PlanOperation, UserConfig } from "../core/types.js";
import type { CliRuntime } from "./runtime.js";

interface ReconcileOptions {
  configPath: string | undefined;
  json: boolean;
}

interface PlanResult {
  conflicts: Array<{ name: string; path: string; reason: string }>;
  operations: PlanOperation[];
  managed: Set<string>;
  statePath: string;
  cwd: string;
  projectRoot?: string;
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

function operationJson(operation: PlanOperation): Record<string, unknown> {
  const arguments_ = commandForOperation(operation);
  return {
    kind: operation.kind,
    scope: operation.skill.scope,
    name: operation.skill.name,
    source: operation.skill.source,
    agents: operation.skill.agents,
    reasons: operation.reasons,
    command: { executable: "npx", arguments: arguments_ },
  };
}

function operationText(operation: PlanOperation): string {
  const agents = operation.skill.agents.join(", ") || "all agents";
  const command = ["npx", ...commandForOperation(operation)]
    .map((part) =>
      /^[A-Za-z0-9@._~:/+-]+$/.test(part) ? part : JSON.stringify(part),
    )
    .join(" ");
  return `${operation.kind.toUpperCase()} ${operation.skill.scope} ${operation.skill.name} for ${agents}\n  ${command}`;
}

async function pullManagedConfig(
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
): Promise<PlanResult> {
  const paths = resolveConfigPaths(runtime.env, explicitPath);
  let config = await loadUserConfig(paths.configPath);
  const machineId = await loadMachineId(paths.machineIdPath);
  config = await pullManagedConfig(config, paths.configPath);
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
    ? await inspectProjectSkills(
        projectRoot,
        await adapter.list("project", projectRoot, runtime.env),
      )
    : [];
  const managed = await loadManagedState(paths.statePath);
  const planned = planChanges(
    desired,
    [...global, ...project],
    managed,
    projectRoot,
  );
  const protectedNames = new Set(
    project.filter((skill) => skill.repositoryOwned).map((skill) => skill.name),
  );
  const conflicts = [
    ...planned,
    ...desired
      .filter(
        (skill) =>
          skill.scope === "project" &&
          project.some((item) => item.name === skill.name && item.missing),
      )
      .map((skill) => ({ kind: "add", skill })),
  ]
    .filter(
      (operation) =>
        operation.kind === "add" &&
        operation.skill.scope === "project" &&
        protectedNames.has(operation.skill.name),
    )
    .map((operation) => ({
      name: operation.skill.name,
      path: projectRoot || runtime.cwd,
      reason:
        "Repository-owned skill differs from the requirement; update it through project Git.",
    }));
  for (const installed of [...global, ...project]) {
    if (
      !installed.repositoryOwned &&
      (installed.source === null || installed.agents.length === 0) &&
      desired.some(
        (skill) =>
          skill.scope === installed.scope && skill.name === installed.name,
      )
    ) {
      conflicts.push({
        name: installed.name,
        path:
          installed.scope === "global" ? "global" : projectRoot || runtime.cwd,
        reason:
          "Installed personal skill has unknown source or agent coverage; verify it before synchronizing.",
      });
    }
  }
  return {
    conflicts,
    operations: protectRepositorySkills(
      planChanges(desired, [...global, ...project], managed, projectRoot),
      project,
    ),
    managed,
    statePath: paths.statePath,
    cwd: projectRoot || runtime.cwd,
    ...(projectRoot ? { projectRoot } : {}),
  };
}

export async function showReconciliation(
  command: "plan" | "status",
  options: ReconcileOptions & { check?: boolean },
  runtime: CliRuntime,
): Promise<number> {
  const result = await buildPlan(runtime, options.configPath);
  const operations = result.operations.map(operationJson);
  const converged = operations.length === 0 && result.conflicts.length === 0;
  emit(
    runtime,
    options.json,
    command,
    { converged, operations, conflicts: result.conflicts },
    converged
      ? "Skilloom is converged."
      : [
          ...result.operations.map(operationText),
          ...result.conflicts.map(
            (conflict) => `${conflict.name}: ${conflict.reason}`,
          ),
        ].join("\n"),
  );
  return command === "plan" && options.check && !converged ? 2 : 0;
}

export async function applyReconciliation(
  options: ReconcileOptions & { yes: boolean },
  runtime: CliRuntime,
): Promise<number> {
  const result = await buildPlan(runtime, options.configPath);
  if (result.conflicts.length) {
    runtime.stdout(
      options.json
        ? JSON.stringify({
            ok: false,
            command: "apply",
            converged: false,
            conflicts: result.conflicts,
            completed: [],
            pending: result.operations.map(operationJson),
          })
        : result.conflicts
            .map((conflict) => `${conflict.name}: ${conflict.reason}`)
            .join("\n"),
    );
    return 2;
  }
  if (result.operations.length === 0) {
    emit(
      runtime,
      options.json,
      "apply",
      { completed: [], pending: [], converged: true },
      "No changes to apply.",
    );
    return 0;
  }
  if (!options.json)
    runtime.stdout(result.operations.map(operationText).join("\n"));
  if (!options.yes && !runtime.isTTY) {
    emit(
      runtime,
      options.json,
      "apply",
      {
        completed: [],
        pending: result.operations.map(operationJson),
        canceled: true,
      },
      "Refusing to prompt outside a terminal. Pass --yes to apply.",
    );
    return 5;
  }
  if (
    !options.yes &&
    !(await runtime.confirm(`Apply ${result.operations.length} operation(s)?`))
  ) {
    emit(
      runtime,
      options.json,
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
  const liveOutput =
    options.json || !runtime.isTTY
      ? {}
      : {
          ...(runtime.writeStdout
            ? {
                onStdout: (chunk: string) =>
                  runtime.writeStdout?.(
                    redactProcessOutput(chunk, runtime.env),
                  ),
              }
            : {}),
          ...(runtime.writeStderr
            ? {
                onStderr: (chunk: string) =>
                  runtime.writeStderr?.(
                    redactProcessOutput(chunk, runtime.env),
                  ),
              }
            : {}),
        };
  for (let index = 0; index < result.operations.length; index += 1) {
    const operation = result.operations[index];
    if (!operation) continue;
    const execution = await adapter.execute(
      operation,
      result.cwd,
      runtime.env,
      liveOutput,
    );
    if (execution.code !== 0) {
      const stdout = redactProcessOutput(execution.stdout, runtime.env);
      const stderr = redactProcessOutput(execution.stderr, runtime.env);
      const pending = result.operations.slice(index);
      const payload = {
        ok: false,
        error: {
          code: "execution_failed",
          message: stderr.trim() || `npx exited ${execution.code}`,
        },
        completed: completed.map(operationJson),
        pending: pending.map(operationJson),
        upstream: {
          exitCode: execution.code,
          stdout,
          stderr,
        },
      };
      if (!options.json && !liveOutput.onStdout && stdout.trim())
        runtime.stdout(stdout.trim());
      if (!options.json && !liveOutput.onStderr && stderr.trim())
        runtime.stderr(stderr.trim());
      runtime.stderr(
        options.json
          ? JSON.stringify(payload)
          : `Apply stopped: ${payload.error.message}`,
      );
      return 4;
    }
    if (!options.json && !liveOutput.onStdout && execution.stdout.trim())
      runtime.stdout(redactProcessOutput(execution.stdout, runtime.env).trim());
    if (!options.json && !liveOutput.onStderr && execution.stderr.trim())
      runtime.stderr(redactProcessOutput(execution.stderr, runtime.env).trim());
    completed.push(operation);
    const key = managedStateKey(operation.skill, result.projectRoot);
    if (operation.kind === "add") result.managed.add(key);
    else result.managed.delete(key);
    await saveManagedState(result.statePath, result.managed);
  }
  emit(
    runtime,
    options.json,
    "apply",
    { completed: completed.map(operationJson), pending: [], converged: true },
    `Applied ${completed.length} operation(s).`,
  );
  return 0;
}
