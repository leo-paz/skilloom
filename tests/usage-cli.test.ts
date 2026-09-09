import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { defaultRuntime } from "../src/cli/runtime.js";
import { usageCommand } from "../src/cli/usage.js";
import { inventoryFixture } from "./tui-fixture.js";

it("backfills a saved inventory without discovery, changes to skills or Git", async () => {
  const home = await mkdtemp(join(tmpdir(), "usage-cli-"));
  const directory = join(home, ".config/skilloom");
  await mkdir(directory, { recursive: true });
  const inventory = inventoryFixture();
  await writeFile(join(directory, "inventory.json"), JSON.stringify(inventory));
  const output: string[] = [];
  const runtime = {
    ...defaultRuntime(),
    env: { HOME: home },
    stdout: (s: string) => output.push(s),
  };
  expect(await usageCommand(["backfill", "--once"], runtime)).toBe(0);
  const saved = JSON.parse(
    await readFile(join(directory, "inventory.json"), "utf8"),
  );
  expect(saved.skillUsage.backfill.complete).toBe(true);
  expect(saved.globalSkills[0].name).toBe("code-review");
  expect(output.map((s) => JSON.parse(s))[0].command).toBe("usage backfill");
  await rm(home, { recursive: true, force: true });
});
