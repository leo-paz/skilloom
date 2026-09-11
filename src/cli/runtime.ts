import { type ProcessRunner, runProcess } from "../adapters/skills.js";

import type { InventoryProgress } from "../core/types.js";

export interface CliRuntime {
  signal?: AbortSignal | undefined;
  onProgress?: ((event: InventoryProgress) => void) | undefined;
  cwd: string;
  env: NodeJS.ProcessEnv;
  isTTY: boolean;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  writeStdout?: (chunk: string) => void;
  writeStderr?: (chunk: string) => void;
  run: ProcessRunner;
  confirm: (message: string) => Promise<boolean>;
}

export function defaultRuntime(): CliRuntime {
  return {
    onProgress: (event) => {
      process.stderr.write(
        `[${event.phase}] ${event.completed}/${event.total}${event.path ? ` ${event.path}` : ""}\n`,
      );
    },
    cwd: process.cwd(),
    env: process.env,
    isTTY: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    stdout: (line) => process.stdout.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
    writeStdout: (chunk) => process.stdout.write(chunk),
    writeStderr: (chunk) => process.stderr.write(chunk),
    run: runProcess,
    confirm: async (message) => {
      const { confirm, isCancel } = await import("@clack/prompts");
      const answer = await confirm({ message, initialValue: false });
      return !isCancel(answer) && answer;
    },
  };
}
