import {
  commandForOperation,
  redactProcessOutput,
  SkillsAdapter,
} from "../adapters/skills.js";
import {
  loadManagedState,
  resolveConfigPaths,
  saveManagedState,
} from "../core/config.js";
import { managedStateKey } from "../core/plan.js";
import type { MachineInventory, PlanOperation } from "../core/types.js";
import { loadCurrentInventory } from "./inventory.js";
import type { CliRuntime } from "./runtime.js";

export interface TargetedOperation {
  operation: PlanOperation;
  cwd: string;
  project?: string | undefined;
}

export function inventoryIssues(inventory: MachineInventory): string[] {
  const issues =
    inventory.discovery.status === "incomplete"
      ? [
          "Workspace discovery is incomplete; restore access before reconciling.",
        ]
      : [];
  for (const project of inventory.projects) {
    for (const checkout of project.checkouts) {
      for (const skill of checkout.skills ?? []) {
        if (skill.conflict)
          issues.push(`${checkout.path}: ${skill.name}: ${skill.conflict}`);
      }
    }
  }
  return issues;
}

export function targets(
  inventory: MachineInventory,
  cwd: string,
): TargetedOperation[] {
  const output: TargetedOperation[] = inventory.operations
    .filter((operation) => operation.skill.scope === "global")
    .map((operation) => ({ operation, cwd }));
  for (const project of inventory.projects) {
    for (const checkout of project.checkouts) {
      for (const operation of checkout.operations ?? []) {
        output.push({ operation, cwd: checkout.path, project: project.id });
      }
    }
  }
  return output.sort(
    (left, right) =>
      left.operation.kind.localeCompare(right.operation.kind) ||
      left.cwd.localeCompare(right.cwd) ||
      left.operation.skill.name.localeCompare(right.operation.skill.name),
  );
}

export function operationJson(
  target: TargetedOperation,
): Record<string, unknown> {
  const operation = target.operation;
  return {
    kind: operation.kind,
    scope: operation.skill.scope,
    name: operation.skill.name,
    source: operation.skill.source,
    agents: operation.skill.agents,
    reasons: operation.reasons,
    cwd: target.cwd,
    ...(target.project ? { project: target.project } : {}),
    command: {
      executable: "npx",
      arguments: commandForOperation(operation),
    },
  };
}

export function operationText(target: TargetedOperation): string {
  const operation = target.operation;
  return `${operation.kind.toUpperCase()} ${operation.skill.name} · ${operation.skill.scope}${target.project ? ` · ${target.project}` : ""}\n  in ${target.cwd}`;
}

export async function showWorkspacePlan(
  command: "plan" | "status",
  args: string[],
  runtime: CliRuntime,
  json: boolean,
): Promise<number> {
  const configIndex = args.indexOf("--config");
  const configPath = configIndex === -1 ? undefined : args[configIndex + 1];
  if (configIndex !== -1 && !configPath)
    throw new Error("--config requires a value");
  const inventory = await loadCurrentInventory(runtime, configPath);
  const operations = targets(inventory, runtime.cwd);
  const issues = inventoryIssues(inventory);
  const converged = operations.length === 0 && issues.length === 0;
  runtime.stdout(
    json
      ? JSON.stringify({
          ok: issues.length === 0,
          command,
          all: true,
          converged,
          issues,
          operations: operations.map(operationJson),
        })
      : converged
        ? "All discovered projects are converged."
        : [...operations.map(operationText), ...issues].join("\n"),
  );
  return issues.length > 0 ||
    (command === "plan" && args.includes("--check") && !converged)
    ? 2
    : 0;
}

export async function applyWorkspacePlan(
  args: string[],
  runtime: CliRuntime,
  json: boolean,
  currentInventory?: MachineInventory,
): Promise<number> {
  const configIndex = args.indexOf("--config");
  const configPath = configIndex === -1 ? undefined : args[configIndex + 1];
  if (configIndex !== -1 && !configPath)
    throw new Error("--config requires a value");
  const inventory =
    currentInventory ?? (await loadCurrentInventory(runtime, configPath));
  const operations = targets(inventory, runtime.cwd);
  const issues = inventoryIssues(inventory);
  if (issues.length > 0) {
    runtime.stdout(
      json
        ? JSON.stringify({
            ok: false,
            command: "apply",
            all: true,
            converged: false,
            completed: [],
            pending: operations.map(operationJson),
            issues,
          })
        : issues.join("\n"),
    );
    return 2;
  }
  if (operations.length === 0) {
    runtime.stdout(
      json
        ? JSON.stringify({
            ok: true,
            command: "apply",
            all: true,
            completed: [],
            pending: [],
            converged: true,
          })
        : "No workspace changes to apply.",
    );
    return 0;
  }
  if (!args.includes("--yes") && !runtime.isTTY) {
    runtime.stdout(
      json
        ? JSON.stringify({
            ok: true,
            command: "apply",
            all: true,
            completed: [],
            pending: operations.map(operationJson),
            canceled: true,
          })
        : "Refusing to prompt outside a terminal. Pass --yes to apply.",
    );
    return 5;
  }
  if (
    !args.includes("--yes") &&
    !(await runtime.confirm(
      `Apply ${operations.length} workspace operation(s)?`,
    ))
  ) {
    return 5;
  }
  const paths = resolveConfigPaths(runtime.env, configPath);
  const managed = await loadManagedState(paths.statePath);
  const adapter = new SkillsAdapter(runtime.run);
  const completed: TargetedOperation[] = [];
  for (let index = 0; index < operations.length; index += 1) {
    const target = operations[index];
    if (!target) continue;
    const result = await adapter.execute(
      target.operation,
      target.cwd,
      runtime.env,
    );
    if (result.code !== 0) {
      const pending = operations.slice(index);
      runtime.stderr(
        json
          ? JSON.stringify({
              ok: false,
              error: {
                code: "execution_failed",
                message:
                  redactProcessOutput(result.stderr, runtime.env).trim() ||
                  `npx exited ${result.code}`,
              },
              completed: completed.map(operationJson),
              pending: pending.map(operationJson),
            })
          : `Apply stopped: ${redactProcessOutput(result.stderr, runtime.env).trim()}`,
      );
      return 4;
    }
    completed.push(target);
    const key = managedStateKey(
      target.operation.skill,
      target.operation.skill.scope === "project" ? target.cwd : undefined,
    );
    if (target.operation.kind === "add") managed.add(key);
    else managed.delete(key);
    await saveManagedState(paths.statePath, managed);
  }
  runtime.stdout(
    json
      ? JSON.stringify({
          ok: true,
          command: "apply",
          all: true,
          completed: completed.map(operationJson),
          pending: [],
          converged: true,
        })
      : `Applied ${completed.length} workspace operation(s).`,
  );
  return 0;
}
