import type { ChildProcess } from "node:child_process";

/** Abortable POSIX children have a private group so Git's SSH children stop too. */
export function abortProcessGroup(
  child: ChildProcess,
  signal?: AbortSignal,
): () => Promise<void> {
  if (!signal || process.platform === "win32") return () => Promise.resolve();
  let stopped = Promise.resolve();
  const kill = (kind: NodeJS.Signals) => {
    if (!child.pid) return;
    try {
      process.kill(-child.pid, kind);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") child.kill(kind);
    }
  };
  const abort = () => {
    kill("SIGTERM");
    // The direct child can close before a descendant stops; retain escalation and await it.
    stopped = new Promise((resolve) => {
      setTimeout(() => {
        kill("SIGKILL");
        resolve();
      }, 1000);
    });
  };
  signal.addEventListener("abort", abort, { once: true });
  child.once("close", () => signal.removeEventListener("abort", abort));
  if (signal.aborted) abort();
  return () => stopped;
}
