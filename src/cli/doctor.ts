import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import packageMetadata from "../../package.json" with { type: "json" };
import { redactProcessOutput } from "../adapters/skills.js";
import {
  findProjectRoot,
  loadUserConfig,
  resolveConfigPaths,
} from "../core/config.js";
import type { CliRuntime } from "./runtime.js";

interface Diagnostic {
  name: string;
  ok: boolean;
  detail: string;
}
export function inspectRuntime(
  nodeVersion = process.versions.node,
  bunVersion = process.versions.bun,
): Diagnostic {
  const major = Number(nodeVersion.split(".")[0]);
  return {
    name: "runtime",
    ok: Number.isInteger(major) && major >= 20,
    detail: `${bunVersion ? `Bun ${bunVersion} (Node compatibility ${nodeVersion})` : `Node ${nodeVersion}`} · requires Node >=20 · ${process.execPath}`,
  };
}
const require = createRequire(import.meta.url);
export async function doctor(
  args: string[],
  runtime: CliRuntime,
  json: boolean,
): Promise<number> {
  const index = args.indexOf("--config");
  const explicit = index < 0 ? undefined : args[index + 1];
  if (index >= 0 && (!explicit || explicit.startsWith("--")))
    throw new Error("--config requires a value");
  const paths = resolveConfigPaths(runtime.env, explicit);
  const projectRoot = findProjectRoot(runtime.cwd);
  const checks: Diagnostic[] = [inspectRuntime()];
  const detail = (value: unknown) =>
    redactProcessOutput(
      value instanceof Error ? value.message : String(value),
      runtime.env,
    );
  try {
    const result = await runtime.run("git", ["--version"], {
      cwd: runtime.cwd,
      env: runtime.env,
    });
    checks.push({
      name: "git",
      ok: result.code === 0,
      detail: detail(
        (result.stdout || result.stderr).trim() || `git exited ${result.code}`,
      ),
    });
  } catch (error) {
    checks.push({ name: "git", ok: false, detail: detail(error) });
  }
  try {
    // Resolve beside Skilloom, exactly as SkillsAdapter does; never fetch a different package.
    const metadataPath = require.resolve("skills/package.json");
    const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as {
      version?: unknown;
    };
    const expected = packageMetadata.dependencies.skills;
    if (metadata.version !== expected)
      throw new Error(
        `Installed skills dependency is ${String(metadata.version)}; Skilloom requires pinned ${expected}. Reinstall Skilloom to repair its dependency.`,
      );
    const executable = join(dirname(metadataPath), "bin", "cli.mjs");
    const result = await runtime.run(
      process.execPath,
      [executable, "--version"],
      { cwd: runtime.cwd, env: runtime.env },
    );
    const observed = result.stdout.trim();
    checks.push({
      name: "skills",
      ok: result.code === 0 && observed === expected,
      detail:
        result.code === 0
          ? detail(
              `Pinned ${expected}; executable reported ${observed || "no version"}`,
            )
          : detail(
              result.stderr.trim() ||
                `Pinned skills ${expected} exited ${result.code}`,
            ),
    });
  } catch (error) {
    checks.push({ name: "skills", ok: false, detail: detail(error) });
  }
  checks.push({
    name: "project",
    ok: true,
    detail: projectRoot || "No Git repository found",
  });
  if (projectRoot) {
    try {
      const result = await runtime.run("git", ["status", "--porcelain"], {
        cwd: projectRoot,
        env: runtime.env,
      });
      const changes = result.stdout.trim().split("\n").filter(Boolean).length;
      checks.push({
        name: "repository",
        ok: result.code === 0,
        detail:
          result.code !== 0
            ? detail(result.stderr.trim() || `git status exited ${result.code}`)
            : changes === 0
              ? "clean"
              : `${changes} uncommitted change(s)`,
      });
    } catch (error) {
      checks.push({ name: "repository", ok: false, detail: detail(error) });
    }
  } else
    checks.push({ name: "repository", ok: true, detail: "not applicable" });
  try {
    await loadUserConfig(paths.configPath);
    checks.push({ name: "config", ok: true, detail: paths.configPath });
  } catch (error) {
    checks.push({ name: "config", ok: false, detail: detail(error) });
  }
  const ok = checks.every((check) => check.ok);
  runtime.stdout(
    json
      ? JSON.stringify({ ok, command: "doctor", checks })
      : checks
          .map(
            (check) =>
              `${check.ok ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`,
          )
          .join("\n"),
  );
  return ok ? 0 : 4;
}
