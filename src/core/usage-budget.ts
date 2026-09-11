import { performance } from "node:perf_hooks";
import type { SkillUsageScan } from "./skill-usage.js";

export const BACKFILL_BUDGET_MS = 120_000;

/** One budget for a CLI invocation or a dashboard refresh, never one per batch. */
export class UsageBackfillBudget {
  private startedAt: number | undefined;
  constructor(
    readonly milliseconds = BACKFILL_BUDGET_MS,
    private readonly now = () => performance.now(),
  ) {}
  start(): void {
    this.startedAt ??= this.now();
  }
  reset(): void {
    this.startedAt = undefined;
  }
  get expired(): boolean {
    return (
      this.startedAt !== undefined &&
      this.now() - this.startedAt >= this.milliseconds
    );
  }
  mark(scan: SkillUsageScan | undefined): void {
    if (!scan?.backfill) return;
    if (!scan.backfill.complete && this.expired)
      scan.backfill.paused = "time_limit";
    else delete scan.backfill.paused;
  }
}

export function backfillBudgetMilliseconds(args: string[]): number {
  const index = args.indexOf("--max-seconds");
  if (index < 0) return BACKFILL_BUDGET_MS;
  const value = args[index + 1] ?? "";
  const seconds = Number(value);
  if (!/^\d+$/.test(value) || seconds < 1 || seconds > 180)
    throw new Error("--max-seconds requires a whole number from 1 to 180.");
  return seconds * 1000;
}
