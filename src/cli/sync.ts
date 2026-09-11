import { createHash } from "node:crypto";
import { GitExecutionError } from "../adapters/git.js";
import { SkillsExecutionError } from "../adapters/skills.js";
import { loadUserConfig, resolveConfigPaths } from "../core/config.js";
import type { MachineInventory } from "../core/types.js";
import { loadCurrentInventory } from "./inventory.js";
import { observeMachine } from "./observe.js";
import type { CliRuntime } from "./runtime.js";
import {
  applyWorkspacePlan,
  inventoryIssues,
  operationJson,
  operationText,
  targets,
} from "./workspace-reconcile.js";

export type SyncPhaseStatus =
  | "pending"
  | "running"
  | "succeeded"
  | "failed"
  | "skipped";
export interface SyncPhase {
  status: SyncPhaseStatus;
  error?: string;
}
export interface SyncPhases {
  apply: SyncPhase;
  verify: SyncPhase;
  publish: SyncPhase;
}

function planFingerprint(inventory: MachineInventory, cwd: string): string {
  const normalizedOperations = targets(inventory, cwd)
    .map((target) => {
      const { command: _command, ...operation } = operationJson(target);
      return JSON.stringify({
        ...operation,
        agents: [...target.operation.skill.agents].sort(),
        reasons: [...target.operation.reasons].sort(),
      });
    })
    .sort();
  return createHash("sha256")
    .update(
      JSON.stringify({
        machine: inventory.machine.id,
        ownershipRelease: {
          releasedKeys: [
            ...(inventory.ownershipRelease?.releasedKeys ?? []),
          ].sort(),
          acknowledgedKeys: [
            ...(inventory.ownershipRelease?.acknowledgedKeys ?? []),
          ].sort(),
        },
        operations: normalizedOperations,
        issues: inventoryIssues(inventory).sort(),
      }),
    )
    .digest("hex");
}

export async function syncMachine(
  args: string[],
  runtime: CliRuntime,
  json: boolean,
  onPhase?: (phases: SyncPhases) => void,
): Promise<number> {
  const phases: SyncPhases = {
    apply: { status: "skipped" },
    verify: { status: "skipped" },
    publish: { status: "skipped" },
  };
  const phase = (
    name: keyof SyncPhases,
    status: SyncPhaseStatus,
    error?: string,
  ) => {
    phases[name] = error ? { status, error } : { status };
    onPhase?.({
      apply: { ...phases.apply },
      verify: { ...phases.verify },
      publish: { ...phases.publish },
    });
  };
  const configIndex = args.indexOf("--config");
  const explicitConfig = configIndex === -1 ? undefined : args[configIndex + 1];
  if (
    configIndex !== -1 &&
    (!explicitConfig || explicitConfig.startsWith("--"))
  )
    throw new Error("--config requires a value");
  const expectIndex = args.indexOf("--expect");
  const expectedFingerprint =
    expectIndex === -1 ? undefined : args[expectIndex + 1];
  if (
    expectIndex !== -1 &&
    (!expectedFingerprint || !/^[a-f0-9]{64}$/.test(expectedFingerprint))
  )
    throw new Error(
      "--expect requires the 64-character plan fingerprint from sync --dry-run --json",
    );
  const paths = resolveConfigPaths(runtime.env, explicitConfig);
  let initial = await loadCurrentInventory(runtime, explicitConfig);
  const operations = targets(initial, runtime.cwd);
  const issues = inventoryIssues(initial);
  let fingerprint = planFingerprint(initial, runtime.cwd);
  const emit = (result: Record<string, unknown>, message: string) =>
    runtime.stdout(
      json
        ? JSON.stringify({ ...result, fingerprint, phases, command: "sync" })
        : message,
    );
  if (args.includes("--dry-run")) {
    emit(
      {
        ok: issues.length === 0,
        dryRun: true,
        converged: operations.length === 0 && issues.length === 0,
        machine: initial.machine,
        operations: operations.map(operationJson),
        ...(initial.ownershipRelease
          ? { ownershipRelease: initial.ownershipRelease }
          : {}),
        issues,
        published: false,
      },
      [...operations.map(operationText), ...issues].join("\n") ||
        "This machine is up to date.",
    );
    return issues.length > 0 ? 2 : 0;
  }
  if (expectedFingerprint && expectedFingerprint !== fingerprint) {
    emit(
      {
        ok: false,
        canceled: true,
        converged: false,
        published: false,
        pending: operations.map(operationJson),
        issues,
        error: {
          code: "plan_changed",
          message:
            "The sync plan changed since review. Run sync --dry-run --json and review the new plan before applying.",
        },
      },
      "Sync canceled because the plan changed since review. Review sync --dry-run before applying again.",
    );
    return 5;
  }
  if (issues.length > 0) {
    emit(
      {
        ok: false,
        converged: false,
        issues,
        pending: operations.map(operationJson),
        published: false,
      },
      issues.join("\n"),
    );
    return 2;
  }
  if (operations.length > 0 && !args.includes("--yes")) {
    if (runtime.isTTY && !json)
      runtime.stdout(operations.map(operationText).join("\n"));
    if (
      !runtime.isTTY ||
      !(await runtime.confirm(
        `Apply ${operations.length} operation(s) on ${initial.machine.name}?`,
      ))
    ) {
      emit(
        {
          ok: false,
          canceled: true,
          converged: false,
          pending: operations.map(operationJson),
          published: false,
        },
        "Sync canceled. Pass --yes to apply without prompting.",
      );
      return 5;
    }
  }
  if (operations.length > 0 && !args.includes("--yes")) {
    const refreshed = await loadCurrentInventory(runtime, explicitConfig);
    const refreshedFingerprint = planFingerprint(refreshed, runtime.cwd);
    if (refreshedFingerprint !== fingerprint) {
      fingerprint = refreshedFingerprint;
      emit(
        {
          ok: false,
          canceled: true,
          converged: false,
          published: false,
          pending: targets(refreshed, runtime.cwd).map(operationJson),
          issues: inventoryIssues(refreshed),
          error: {
            code: "plan_changed",
            message:
              "The sync plan changed during confirmation. Review the new plan before applying.",
          },
        },
        "Sync canceled because the plan changed during confirmation. Review sync --dry-run before applying again.",
      );
      return 5;
    }
    initial = refreshed;
  }
  let applyResult: Record<string, unknown> = {};
  const applyRuntime = {
    ...runtime,
    stdout: (line: string) => {
      applyResult = JSON.parse(line) as Record<string, unknown>;
    },
    stderr: (line: string) => {
      applyResult = JSON.parse(line) as Record<string, unknown>;
    },
  };
  phase("apply", "running");
  let code: number;
  try {
    code = await applyWorkspacePlan(
      [...args, "--yes"],
      applyRuntime,
      true,
      initial,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    phase("apply", "failed", message);
    emit(
      {
        ...applyResult,
        ok: false,
        converged: false,
        published: false,
        error: { code: "execution_failed", message },
      },
      `Sync stopped while applying changes: ${message}`,
    );
    return error instanceof GitExecutionError ||
      error instanceof SkillsExecutionError
      ? 4
      : 3;
  }
  phase("apply", code === 0 ? "succeeded" : "failed");
  if (code !== 0) {
    emit(
      { ...applyResult, ok: false, converged: false, published: false },
      "Sync stopped while applying changes. Run sync --dry-run to inspect the remaining work.",
    );
    return code;
  }
  // A successful subprocess is not evidence that the installation now matches policy.
  phase("verify", "running");
  let verified;
  try {
    verified = await loadCurrentInventory(runtime, explicitConfig);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    phase("verify", "failed", message);
    emit(
      {
        ok: false,
        converged: false,
        completed: applyResult.completed ?? [],
        published: false,
        partialSuccess: true,
        error: {
          code:
            error instanceof GitExecutionError
              ? "execution_failed"
              : "invalid_or_unavailable",
          message,
        },
      },
      `Changes applied, but verification failed: ${message}`,
    );
    return error instanceof GitExecutionError ? 4 : 3;
  }
  const pending = targets(verified, runtime.cwd);
  const remainingIssues = inventoryIssues(verified);
  const converged = pending.length === 0 && remainingIssues.length === 0;
  phase("verify", converged ? "succeeded" : "failed");
  const config = await loadUserConfig(paths.configPath);
  let observation: Record<string, unknown> = {};
  phase("publish", config.storage.mode === "managed" ? "running" : "skipped");
  try {
    await observeMachine(
      config.storage.mode === "managed" ? [...args, "--publish"] : args,
      {
        ...runtime,
        stdout: (line) => {
          observation = JSON.parse(line) as Record<string, unknown>;
        },
      },
      true,
      verified,
    );
    phase(
      "publish",
      config.storage.mode === "managed"
        ? observation.published
          ? "succeeded"
          : "skipped"
        : "skipped",
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    phase("publish", "failed", message);
    emit(
      {
        ok: false,
        converged,
        machine: verified.machine,
        completed: applyResult.completed ?? [],
        pending: pending.map(operationJson),
        issues: remainingIssues,
        published: false,
        partialSuccess: true,
        error: {
          code:
            error instanceof GitExecutionError
              ? "execution_failed"
              : "invalid_or_unavailable",
          message,
        },
      },
      `Changes applied${converged ? " and verified" : ""}, but status publication failed: ${message}`,
    );
    return error instanceof GitExecutionError ? 4 : 3;
  }
  emit(
    {
      ok: converged,
      partialSuccess: !converged,
      converged,
      machine: verified.machine,
      completed: applyResult.completed ?? [],
      pending: pending.map(operationJson),
      issues: remainingIssues,
      published: observation.published,
      observedAt: observation.observedAt,
    },
    converged
      ? `${verified.machine.name} is up to date${observation.published ? "; status published" : ""}.`
      : "Sync verification found unresolved changes. Run sync --dry-run for details.",
  );
  return converged ? 0 : 2;
}
