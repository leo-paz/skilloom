import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { runProcess } from "../src/adapters/skills.js";
import type { CliRuntime } from "../src/cli/runtime.js";
import { createDashboardBackend } from "../src/tui/dashboard.js";

it("waits for an active mutation before shutdown completes", async () => {
  const home = await mkdtemp(join(tmpdir(), "skilloom-dashboard-stop-"));
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const runtime: CliRuntime = {
    cwd: home,
    env: { HOME: home },
    isTTY: false,
    stdout: () => {},
    stderr: () => {},
    run: runProcess,
    confirm: async () => false,
  };
  const backend = createDashboardBackend(runtime, async (_args, quiet) => {
    await pending;
    quiet.stdout(JSON.stringify({ ok: true }));
    return 0;
  });
  const operation = backend.execute(["add", "review"], () => {});
  let stopped = false;
  const shutdown = backend.shutdown().then(() => {
    stopped = true;
  });
  await Promise.resolve();
  expect(stopped).toBe(false);
  finish();
  await operation;
  await shutdown;
  expect(stopped).toBe(true);
});

it("aborts a running child and waits for it to close", async () => {
  const controller = new AbortController();
  const child = runProcess(
    process.execPath,
    ["-e", "setTimeout(()=>{}, 500)"],
    {
      cwd: tmpdir(),
      env: process.env,
      signal: controller.signal,
      onStdout: () => {},
    },
  );
  controller.abort();
  await expect(child).rejects.toThrow(/abort/i);
});

it("cancels an inventory read and waits for its process runner to stop", async () => {
  const home = await mkdtemp(join(tmpdir(), "skilloom-dashboard-read-"));
  const { runCli } = await import("../src/cli/app.js");
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  let stopped = false;
  const runtime: CliRuntime = {
    cwd: home,
    env: { HOME: home, XDG_CONFIG_HOME: join(home, ".config") },
    isTTY: false,
    stdout: () => {},
    stderr: () => {},
    confirm: async () => false,
    run: async (_executable, _args, options) =>
      new Promise((_resolve, reject) => {
        expect(options.signal).toBeDefined();
        options.signal!.addEventListener(
          "abort",
          () => {
            stopped = true;
            reject(new Error("aborted"));
          },
          { once: true },
        );
        started();
      }),
  };
  expect(await runCli(["init", "--yes", "--json"], runtime)).toBe(0);
  const backend = createDashboardBackend(runtime, runCli);
  const read = backend.load(true, () => {});
  const rejected = expect(read).rejects.toThrow();
  await ready;
  await backend.cancelRead();
  await rejected;
  expect(stopped).toBe(true);
});

it.skipIf(process.platform === "win32")(
  "stops a read subprocess tree even when a descendant ignores SIGTERM",
  async () => {
    const controller = new AbortController();
    let ready!: () => void;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    let descendant = 0;
    const grandchild =
      "process.on('SIGTERM',()=>{});console.log(process.pid);setTimeout(()=>{},10000)";
    const script = `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e',${JSON.stringify(grandchild)}]);child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);setTimeout(()=>{},10000);`;
    const child = runProcess(process.execPath, ["-e", script], {
      cwd: tmpdir(),
      env: process.env,
      signal: controller.signal,
      onStdout: (chunk) => {
        descendant = Number(chunk.trim());
        ready();
      },
    });
    const rejected = expect(child).rejects.toThrow(/abort/i);
    await started;
    controller.abort();
    await rejected;
    expect(descendant).toBeGreaterThan(0);
    await expect
      .poll(
        () => {
          try {
            process.kill(descendant, 0);
            return true;
          } catch {
            return false;
          }
        },
        { timeout: 2000 },
      )
      .toBe(false);
  },
);
