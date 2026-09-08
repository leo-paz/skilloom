import { loadUserConfig, resolveConfigPaths } from "../core/config.js";
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

export async function syncMachine(
  args: string[],
  runtime: CliRuntime,
  json: boolean,
): Promise<number> {
  const configIndex = args.indexOf("--config");
  const explicitConfig = configIndex === -1 ? undefined : args[configIndex + 1];
  if (
    configIndex !== -1 &&
    (!explicitConfig || explicitConfig.startsWith("--"))
  )
    throw new Error("--config requires a value");
  const paths = resolveConfigPaths(runtime.env, explicitConfig);
  const initial = await loadCurrentInventory(runtime, explicitConfig);
  const operations = targets(initial, runtime.cwd);
  const issues = inventoryIssues(initial);
  const emit = (result: Record<string, unknown>, message: string) =>
    runtime.stdout(
      json ? JSON.stringify({ ...result, command: "sync" }) : message,
    );
  if (args.includes("--dry-run")) {
    emit(
      {
        ok: issues.length === 0,
        dryRun: true,
        converged: operations.length === 0 && issues.length === 0,
        machine: initial.machine,
        operations: operations.map(operationJson),
        issues,
        published: false,
      },
      [...operations.map(operationText), ...issues].join("\n") ||
        "This machine is up to date.",
    );
    return issues.length > 0 ? 2 : 0;
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
  const code = await applyWorkspacePlan(
    [...args, "--yes"],
    applyRuntime,
    true,
    initial,
  );
  if (code !== 0) {
    emit(
      { ...applyResult, ok: false, converged: false, published: false },
      "Sync stopped while applying changes. Run sync --dry-run to inspect the remaining work.",
    );
    return code;
  }
  // A successful subprocess is not evidence that the installation now matches policy.
  const verified = await loadCurrentInventory(runtime, explicitConfig);
  const pending = targets(verified, runtime.cwd);
  const remainingIssues = inventoryIssues(verified);
  const converged = pending.length === 0 && remainingIssues.length === 0;
  const config = await loadUserConfig(paths.configPath);
  let observation: Record<string, unknown> = {};
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
  emit(
    {
      ok: converged,
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
