import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureMachineId, resolveConfigPaths } from "../src/core/config.js";

describe("configuration paths", () => {
  it("honors explicit and environment config paths", async () => {
    const home = await mkdtemp(join(tmpdir(), "skilloom-home-"));
    expect(
      resolveConfigPaths({ HOME: home, SKILLOOM_CONFIG: "/tmp/custom.yaml" })
        .configPath,
    ).toBe("/tmp/custom.yaml");
    expect(
      resolveConfigPaths({ HOME: home, XDG_CONFIG_HOME: "/tmp/xdg" })
        .configPath,
    ).toBe("/tmp/xdg/skilloom/config.yaml");
  });

  it("creates and reuses a stable machine identifier", async () => {
    const root = await mkdtemp(join(tmpdir(), "skilloom-machine-"));
    const first = await ensureMachineId(join(root, "machine-id"));
    const second = await ensureMachineId(join(root, "machine-id"));
    expect(second).toBe(first);
    expect(first).toMatch(/^[a-f0-9-]{36}$/);
  });

  it("uses a local locator for external configuration", async () => {
    const home = await mkdtemp(join(tmpdir(), "skilloom-home-"));
    const appDir = join(home, ".config", "skilloom");
    await import("node:fs/promises").then(({ mkdir }) =>
      mkdir(appDir, { recursive: true }),
    );
    await writeFile(
      join(appDir, "location.json"),
      JSON.stringify({ configPath: "/tmp/shared.yaml" }),
    );
    expect(resolveConfigPaths({ HOME: home }).configPath).toBe(
      "/tmp/shared.yaml",
    );
    expect(await readFile(join(appDir, "location.json"), "utf8")).toContain(
      "shared.yaml",
    );
  });
});
