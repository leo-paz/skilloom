import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  parseProjectConfig,
  parseUserConfig,
  serializeProjectConfig,
  serializeUserConfig,
} from "./schema.js";
import type { ProjectConfig, UserConfig } from "./types.js";

export interface ConfigPaths {
  appDir: string;
  configPath: string;
  machineIdPath: string;
  statePath: string;
  locatorPath: string;
}

export function resolveConfigPaths(
  env: NodeJS.ProcessEnv,
  explicitPath?: string,
): ConfigPaths {
  const home = env.HOME;
  if (!home)
    throw new Error("HOME is required to locate Skilloom configuration");
  const appDir = join(env.XDG_CONFIG_HOME || join(home, ".config"), "skilloom");
  const locatorPath = join(appDir, "location.json");
  let locatedPath: string | undefined;
  if (!explicitPath && !env.SKILLOOM_CONFIG && existsSync(locatorPath)) {
    try {
      const locator = JSON.parse(readFileSync(locatorPath, "utf8")) as {
        configPath?: unknown;
      };
      if (typeof locator.configPath === "string")
        locatedPath = locator.configPath;
    } catch (error) {
      throw new Error(
        `invalid Skilloom location file ${locatorPath}: ${String(error)}`,
      );
    }
  }
  return {
    appDir,
    configPath: resolve(
      explicitPath ||
        env.SKILLOOM_CONFIG ||
        locatedPath ||
        join(appDir, "config.yaml"),
    ),
    machineIdPath: join(appDir, "machine-id"),
    statePath: join(appDir, "state.json"),
    locatorPath,
  };
}

export async function ensureMachineId(path: string): Promise<string> {
  try {
    const value = (await readFile(path, "utf8")).trim();
    if (/^[a-f0-9-]{36}$/.test(value)) return value;
    throw new Error(`invalid machine identifier in ${path}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const id = randomUUID();
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${id}\n`, { mode: 0o600 });
  return id;
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  await writeFile(temporary, content, { mode: 0o600 });
  await rename(temporary, path);
}

export async function loadUserConfig(path: string): Promise<UserConfig> {
  try {
    return parseUserConfig(await readFile(path, "utf8"), path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `Skilloom is not initialized. Run skilloom init. Missing ${path}`,
      );
    }
    throw error;
  }
}

export async function saveUserConfig(
  path: string,
  config: UserConfig,
): Promise<void> {
  await atomicWrite(path, serializeUserConfig(config));
}

export async function loadProjectConfig(
  path: string,
): Promise<ProjectConfig | undefined> {
  try {
    return parseProjectConfig(await readFile(path, "utf8"), path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function saveProjectConfig(
  path: string,
  config: ProjectConfig,
): Promise<void> {
  await atomicWrite(path, serializeProjectConfig(config));
}

export async function writeLocator(
  path: string,
  configPath: string,
): Promise<void> {
  await atomicWrite(path, `${JSON.stringify({ configPath }, null, 2)}\n`);
}

export async function loadManagedState(path: string): Promise<Set<string>> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as {
      version?: unknown;
      managed?: unknown;
    };
    if (
      parsed.version !== 1 ||
      !Array.isArray(parsed.managed) ||
      !parsed.managed.every((item) => typeof item === "string")
    ) {
      throw new Error("expected version 1 and a managed string array");
    }
    return new Set(parsed.managed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Set();
    throw new Error(`invalid Skilloom state ${path}: ${String(error)}`);
  }
}

export async function saveManagedState(
  path: string,
  managed: ReadonlySet<string>,
): Promise<void> {
  await atomicWrite(
    path,
    `${JSON.stringify({ version: 1, managed: [...managed].sort() }, null, 2)}\n`,
  );
}

export function findProjectRoot(start: string): string | undefined {
  let current = resolve(start);
  while (true) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}
