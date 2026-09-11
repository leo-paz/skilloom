import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { render } from "ink";
import { createElement } from "react";
import { inspectLocalInstallations } from "../cli/doctor.js";
import { loadCurrentInventory } from "../cli/inventory.js";
import type { CliRuntime } from "../cli/runtime.js";
import { syncMachine } from "../cli/sync.js";
import { collectInventoryUsage, saveUsageIfCurrent } from "../cli/usage.js";
import {
  loadInventorySnapshot,
  resolveConfigPaths,
  saveInventorySnapshot,
} from "../core/config.js";
import { enrichInventoryMetadata } from "../core/enrich-metadata.js";
import type { MachineInventory } from "../core/types.js";
import { UsageBackfillBudget } from "../core/usage-budget.js";
import {
  type CommandResult,
  type DashboardBackend,
  SkilloomApp,
} from "./app.js";

export function createDashboardBackend(
  runtime: CliRuntime,
  run: (args: string[], runtime: CliRuntime) => Promise<number>,
  configPath?: string,
): DashboardBackend & {
  cancelRead: () => Promise<void>;
  shutdown: () => Promise<void>;
} {
  const paths = resolveConfigPaths(runtime.env, configPath);
  const tasks = new Set<{
    promise: Promise<unknown>;
    controller?: AbortController;
  }>();
  let stopping = false;
  const historyBudget = new UsageBackfillBudget();
  const track = <T>(
    readOnly: boolean,
    task: (signal?: AbortSignal) => Promise<T>,
  ): Promise<T> => {
    if (stopping) return Promise.reject(new Error("Dashboard is closing"));
    const controller = readOnly ? new AbortController() : undefined;
    const entry = {
      promise: Promise.resolve() as Promise<unknown>,
      ...(controller ? { controller } : {}),
    };
    const promise = Promise.resolve().then(() => task(controller?.signal));
    entry.promise = promise;
    tasks.add(entry);
    void promise.finally(() => tasks.delete(entry)).catch(() => {});
    return promise;
  };
  const cancelRead = async () => {
    const reads = [...tasks].filter((task) => task.controller);
    for (const task of reads) task.controller?.abort();
    await Promise.allSettled(reads.map((task) => task.promise));
  };
  return {
    cancelRead,
    async inspectInstallations(inventory) {
      return track(true, (signal) =>
        inspectLocalInstallations(
          { ...runtime, signal },
          configPath,
          inventory,
        ),
      );
    },
    async shutdown() {
      stopping = true;
      await cancelRead();
      await Promise.allSettled([...tasks].map((task) => task.promise));
    },
    async collectHistory(inventory: MachineInventory) {
      return track(true, async (signal) => {
        const backfill =
          !inventory.skillUsage?.backfill?.complete && !historyBudget.expired;
        if (backfill) historyBudget.start();
        const next = await collectInventoryUsage(
          inventory,
          runtime.env,
          join(dirname(paths.inventoryPath), "skill-usage-cache.json"),
          backfill ? "backfill" : "tail",
          signal,
        );
        historyBudget.mark(next.skillUsage);
        signal?.throwIfAborted();
        await saveUsageIfCurrent(paths.inventoryPath, inventory, next);
        return next;
      });
    },
    async enrich(inventory: MachineInventory) {
      return track(true, async (signal) => {
        const original = structuredClone(inventory);
        const enriched = await enrichInventoryMetadata(
          original,
          runtime.env,
          join(dirname(paths.inventoryPath), "skill-usage-cache.json"),
          signal,
        );
        signal?.throwIfAborted();
        const saved = await loadInventorySnapshot(paths.inventoryPath);
        const comparable = (value: MachineInventory) => {
          const { cached: _cached, ...snapshot } = value;
          return snapshot;
        };
        if (
          saved &&
          isDeepStrictEqual(comparable(saved), comparable(original))
        ) {
          signal?.throwIfAborted();
          await saveInventorySnapshot(paths.inventoryPath, {
            ...enriched,
            cached: saved.cached,
          });
        }
        return enriched;
      });
    },
    async load(refresh, onProgress) {
      if (refresh) historyBudget.reset();
      return track(true, async (signal) => {
        signal?.throwIfAborted();
        if (!refresh) {
          const saved = await loadInventorySnapshot(paths.inventoryPath);
          if (saved) return { ...saved, cached: true };
        }
        const inventory = await loadCurrentInventory(
          { ...runtime, onProgress, signal },
          configPath,
        );
        signal?.throwIfAborted();
        await saveInventorySnapshot(paths.inventoryPath, inventory);
        return inventory;
      });
    },
    async execute(args, onProgress): Promise<CommandResult> {
      return track(args.includes("--dry-run"), async (signal) => {
        signal?.throwIfAborted();
        let value: Record<string, unknown> = {};
        const capture = (text: string) => {
          try {
            value = JSON.parse(text) as Record<string, unknown>;
          } catch {
            if (text.trim()) value = { error: { message: text.trim() } };
          }
        };
        const quiet: CliRuntime = {
          ...runtime,
          signal,
          isTTY: false,
          stdout: capture,
          stderr: capture,
          writeStdout: () => {},
          writeStderr: () => {},
          onProgress,
          confirm: async () => false,
        };
        const command = [
          ...args,
          ...(configPath ? ["--config", configPath] : []),
        ];
        const code =
          args[0] === "sync"
            ? await syncMachine(command.slice(1), quiet, true, (phases) =>
                onProgress({
                  phase: "Sync",
                  detail: Object.entries(phases)
                    .map(([name, result]) => `${name} ${result.status}`)
                    .join(" · "),
                }),
              )
            : await run([...command, "--json"], quiet);
        signal?.throwIfAborted();
        return { code, value };
      });
    },
  };
}
export async function runDashboard(
  runtime: CliRuntime,
  run: (args: string[], runtime: CliRuntime) => Promise<number>,
  configPath?: string,
): Promise<number> {
  const paths = resolveConfigPaths(runtime.env, configPath);
  const snapshot = await loadInventorySnapshot(paths.inventoryPath);
  const backend = createDashboardBackend(runtime, run, configPath);
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    process.stdout.write("\u001b[?25h\u001b[?1049l");
  };
  process.stdout.write("\u001b[?1049h\u001b[?25l");
  process.once("exit", restore);
  let instance: ReturnType<typeof render> | undefined;
  let terminated = false;
  let closing: Promise<void> | undefined;
  const terminate = () => {
    terminated = true;
    closing ??= backend.shutdown().finally(() => instance?.unmount());
  };
  process.once("SIGTERM", terminate);
  try {
    instance = render(
      createElement(SkilloomApp, {
        initialInventory: snapshot ? { ...snapshot, cached: true } : undefined,
        backend,
      }),
      { exitOnCtrlC: false, patchConsole: false },
    );
    await instance.waitUntilExit();
    await closing;
    return terminated ? 143 : 0;
  } finally {
    await backend.shutdown();
    instance?.unmount();
    instance?.cleanup();
    process.off("SIGTERM", terminate);
    process.off("exit", restore);
    restore();
  }
}
