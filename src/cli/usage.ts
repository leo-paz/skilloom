import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import {
  loadInventorySnapshot,
  resolveConfigPaths,
  saveInventorySnapshot,
} from "../core/config.js";
import { scanSkillUsage } from "../core/skill-usage.js";
import type { MachineInventory } from "../core/types.js";
import { collectUsageHook, configureUsageHooks } from "../core/usage-hooks.js";
import {
  recordHookUsage,
  saveUsageManifest,
  usageDirectory,
} from "../core/usage-journal.js";
import { prepareUsagePaths } from "../core/usage-paths.js";
import { observeMachine, publishedObservation } from "./observe.js";
import type { CliRuntime } from "./runtime.js";

export async function collectInventoryUsage(
  inventory: MachineInventory,
  env: NodeJS.ProcessEnv,
  cachePath: string,
  mode: "tail" | "backfill",
  signal?: AbortSignal,
  restartBackfill = false,
): Promise<MachineInventory> {
  const next = structuredClone(inventory);
  next.skillUsage = await scanSkillUsage({
    env,
    cachePath,
    knownSkills: await prepareUsagePaths(next, env, signal),
    mode,
    restartBackfill,
    ...(signal ? { signal } : {}),
  });
  if (mode === "tail" && inventory.skillUsage?.backfill) {
    next.skillUsage.backfill = inventory.skillUsage.backfill;
    // Preserve completed historical coverage while the tail updates live evidence.
    if (inventory.skillUsage.harnessCoverage)
      next.skillUsage.harnessCoverage = inventory.skillUsage.harnessCoverage;
  }
  return next;
}
export async function saveUsageIfCurrent(
  path: string,
  original: MachineInventory,
  next: MachineInventory,
): Promise<void> {
  const saved = await loadInventorySnapshot(path);
  const comparable = (value: MachineInventory) => {
    const { cached: _cached, ...rest } = value;
    return rest;
  };
  if (saved && isDeepStrictEqual(comparable(saved), comparable(original)))
    await saveInventorySnapshot(path, { ...next, cached: saved.cached });
}
async function hookInput(): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let bytes = 0;
    const chunks: Buffer[] = [];
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Hook input timeout"));
    }, 1500);
    const cleanup = () => {
      clearTimeout(timeout);
      process.stdin.off("data", onData);
      process.stdin.off("end", onEnd);
      process.stdin.off("error", onError);
      process.stdin.pause();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onData = (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 1024 * 1024) {
        cleanup();
        reject(new Error("Hook input too large"));
      } else chunks.push(chunk);
    };
    const onEnd = () => {
      cleanup();
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(error);
      }
    };
    process.stdin.on("data", onData);
    process.stdin.on("end", onEnd);
    process.stdin.on("error", onError);
    process.stdin.resume();
  });
}
export async function usageCommand(
  args: string[],
  runtime: CliRuntime,
): Promise<number> {
  const paths = resolveConfigPaths(runtime.env);
  const cachePath = join(
    dirname(paths.inventoryPath),
    "skill-usage-cache.json",
  );
  const directory = usageDirectory(cachePath);
  const action = args[0] ?? "status";
  if (action === "hook") {
    // Hook commands must never affect agent execution, including malformed input and unavailable state.
    try {
      const harness = args[1];
      if (harness !== "claude" && harness !== "pi") return 0;
      await collectUsageHook({
        harness,
        payload: await hookInput(),
        env: runtime.env,
        record: (event) => recordHookUsage(directory, event),
      });
    } catch {}
    return 0;
  }
  if (action === "publish") {
    const inventory = await loadInventorySnapshot(paths.inventoryPath);
    if (!inventory) throw new Error("Refresh inventory first.");
    if (args.includes("--dry-run")) {
      runtime.stdout(
        JSON.stringify({
          ok: true,
          dryRun: true,
          observation: publishedObservation(inventory),
        }),
      );
      return 0;
    }
    return observeMachine(["--publish"], runtime, true, inventory);
  }
  if (action === "install" || action === "uninstall" || action === "status") {
    if (action === "install") {
      const inventory = await loadInventorySnapshot(paths.inventoryPath);
      if (!inventory)
        throw new Error(
          "Refresh inventory before installing usage collectors.",
        );
      await saveUsageManifest(
        directory,
        await prepareUsagePaths(inventory, runtime.env),
      );
    }
    const hooks = await configureUsageHooks({
      env: runtime.env,
      command: [process.execPath, process.argv[1]!],
      action,
    });
    const inventory = await loadInventorySnapshot(paths.inventoryPath);
    runtime.stdout(
      JSON.stringify({
        ok: true,
        command: `usage ${action}`,
        hooks,
        coverage: inventory?.skillUsage?.harnessCoverage,
        backfill: inventory?.skillUsage?.backfill,
      }),
    );
    return 0;
  }
  if (action !== "backfill" && action !== "refresh")
    throw new Error(
      "Usage: skilloom usage status|install|uninstall|backfill [--once] [--restart]|refresh|publish [--dry-run]",
    );
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  let passes = 0;
  try {
    do {
      const inventory = await loadInventorySnapshot(paths.inventoryPath);
      if (!inventory) throw new Error("Refresh inventory first.");
      const next = await collectInventoryUsage(
        inventory,
        runtime.env,
        cachePath,
        action === "backfill" ? "backfill" : "tail",
        abort.signal,
        passes === 0 && args.includes("--restart"),
      );
      await saveUsageIfCurrent(paths.inventoryPath, inventory, next);
      passes++;
      runtime.stdout(
        JSON.stringify({
          ok: true,
          command: `usage ${action}`,
          passes,
          backfill: next.skillUsage?.backfill,
          coverage: next.skillUsage?.harnessCoverage,
          events: next.skillUsage?.history?.length,
        }),
      );
      if (
        action === "refresh" ||
        args.includes("--once") ||
        next.skillUsage?.backfill?.complete ||
        abort.signal.aborted
      )
        break;
      await delay(50, undefined, { signal: abort.signal });
    } while (true);
  } catch (error) {
    if (!abort.signal.aborted) throw error;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
  return abort.signal.aborted ? 5 : 0;
}
