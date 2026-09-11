import { spawn } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import packageMetadata from "../../package.json" with { type: "json" };
import { applyProvenance } from "../core/provenance.js";
import type { InstalledSkill, PlanOperation, Scope } from "../core/types.js";
import { abortProcessGroup } from "./process.js";

const upstreamSkill = z
  .object({
    name: z.string().min(1),
    scope: z.enum(["global", "project"]),
    agents: z.array(z.string()),
    source: z.string().nullable().optional(),
    sourceUrl: z.string().nullable().optional(),
    path: z.string().optional(),
  })
  .passthrough();

const agentAliases: Record<string, string> = {
  Codex: "codex",
  "Claude Code": "claude-code",
  Cursor: "cursor",
};

export function parseSkillsList(text: string): InstalledSkill[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `invalid skills list output: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const parsed = z.array(upstreamSkill).safeParse(raw);
  if (!parsed.success)
    throw new Error(`invalid skills list output: ${parsed.error.message}`);
  return parsed.data.map((skill) => ({
    name: skill.name,
    ...(skill.path ? { path: skill.path } : {}),
    source: skill.source ?? skill.sourceUrl ?? null,
    scope: skill.scope,
    agents: skill.agents.map(
      (agent) =>
        agentAliases[agent] ?? agent.toLowerCase().replaceAll(" ", "-"),
    ),
  }));
}

// skills@1.5.25 getAgentBaseDir uses the canonical directory in both scopes
// for agents whose metadata declares skillsDir: ".agents/skills".
export const universalInstallationAgents = [
  "amp",
  "antigravity",
  "antigravity-cli",
  "cline",
  "codex",
  "cursor",
  "deepagents",
  "dexto",
  "droid",
  "firebender",
  "gemini-cli",
  "github-copilot",
  "kilo",
  "kimi-code-cli",
  "loaf",
  "opencode",
  "replit",
  "sarvam-code",
  "warp",
  "zed",
  "promptscript",
  "universal",
];

export async function normalizeInstallationCoverage(
  skills: InstalledSkill[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<InstalledSkill[]> {
  return Promise.all(
    skills.map(async (skill) => {
      if (!skill.path) return skill;
      const canonical = join(
        skill.scope === "global" ? env.HOME || homedir() : cwd,
        ".agents",
        "skills",
      );
      try {
        if (
          (await realpath(dirname(resolve(cwd, skill.path)))) !==
          (await realpath(canonical))
        )
          return skill;
        if (!(await stat(join(resolve(cwd, skill.path), "SKILL.md"))).isFile())
          return skill;
      } catch {
        return skill;
      }
      return {
        ...skill,
        detectedAgents: [...skill.agents],
        agents: [
          ...new Set([...skill.agents, ...universalInstallationAgents]),
        ].sort(),
      };
    }),
  );
}

const require = createRequire(import.meta.url);
let upstreamExecutable: string | undefined;
function packagedSkillsExecutable(): string {
  upstreamExecutable ??= join(
    dirname(require.resolve("skills/package.json")),
    "bin",
    "cli.mjs",
  );
  return upstreamExecutable;
}

export function commandForOperation(operation: PlanOperation): string[] {
  const { skill } = operation;
  const scope = skill.scope === "global" ? ["--global"] : [];
  const agents = skill.agents.length > 0 ? ["--agent", ...skill.agents] : [];
  if (operation.kind === "add") {
    if (!skill.source)
      throw new Error(`cannot add ${skill.name} without a source`);
    return [
      "skills",
      "add",
      skill.source,
      "--skill",
      skill.name,
      ...agents,
      ...scope,
      "--yes",
    ];
  }
  return ["skills", "remove", skill.name, ...agents, ...scope, "--yes"];
}

/** Portable reproduction command matching the bundled dependency version. */
export function portableCommandForOperation(
  operation: PlanOperation,
): string[] {
  return [
    "--yes",
    `skills@${packageMetadata.dependencies.skills}`,
    ...commandForOperation(operation).slice(1),
  ];
}

export interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

export class SkillsExecutionError extends Error {
  override readonly name = "SkillsExecutionError";
}

export function redactProcessOutput(
  output: string,
  env: NodeJS.ProcessEnv,
): string {
  let redacted = output;
  for (const [name, value] of Object.entries(env)) {
    if (!/(TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY)/i.test(name))
      continue;
    if (value && value.length >= 4)
      redacted = redacted.replaceAll(value, "[REDACTED]");
  }
  return redacted;
}

export interface ProcessOptions {
  signal?: AbortSignal | undefined;
  cwd: string;
  env: NodeJS.ProcessEnv;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

export type ProcessRunner = (
  executable: string,
  args: string[],
  options: ProcessOptions,
) => Promise<ProcessResult>;

export const runProcess: ProcessRunner = async (executable, args, options) =>
  new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      signal: options.signal,
      detached: Boolean(options.signal) && process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stopped = abortProcessGroup(child, options.signal);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      const text = String(chunk);
      stdout += text;
      options.onStdout?.(text);
    });
    child.stderr.on("data", (chunk) => {
      const text = String(chunk);
      stderr += text;
      options.onStderr?.(text);
    });
    let failure: Error | undefined;
    child.once("error", (error) => {
      failure = error;
    });
    child.once("close", (code) => {
      void stopped().then(() => {
        if (failure) reject(failure);
        else resolve({ code: code ?? 1, stdout, stderr });
      });
    });
  });

export class SkillsAdapter {
  constructor(
    private readonly runner: ProcessRunner = runProcess,
    private readonly executable = "npx",
    private readonly signal?: AbortSignal,
  ) {}

  private invoke(
    args: string[],
    options: ProcessOptions,
  ): Promise<ProcessResult> {
    if (this.signal) options = { ...options, signal: this.signal };
    // Injected runners and explicit executables retain the public test/embedding contract.
    if (this.runner !== runProcess || this.executable !== "npx")
      return this.runner(this.executable, args, options);
    return this.runner(
      process.execPath,
      [packagedSkillsExecutable(), ...args.slice(1)],
      options,
    );
  }

  async list(
    scope: Scope,
    cwd: string,
    env: NodeJS.ProcessEnv = process.env,
  ): Promise<InstalledSkill[]> {
    const args = [
      "skills",
      "list",
      ...(scope === "global" ? ["--global"] : []),
      "--json",
    ];
    let result: ProcessResult;
    try {
      result = await this.invoke(args, { cwd, env });
    } catch (error) {
      throw new SkillsExecutionError(
        `skills list failed to start: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    if (result.code !== 0)
      throw new SkillsExecutionError(
        `skills list failed with exit ${result.code}: ${redactProcessOutput(result.stderr, env).trim()}`,
      );
    return applyProvenance(
      await normalizeInstallationCoverage(
        parseSkillsList(result.stdout),
        cwd,
        env,
      ),
      cwd,
      env,
    );
  }

  async execute(
    operation: PlanOperation,
    cwd: string,
    env: NodeJS.ProcessEnv = process.env,
    output: Pick<ProcessOptions, "onStdout" | "onStderr"> = {},
  ): Promise<ProcessResult> {
    try {
      return await this.invoke(commandForOperation(operation), {
        cwd,
        env,
        ...output,
      });
    } catch (error) {
      throw new SkillsExecutionError(
        `skills ${operation.kind} failed to start: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }

  async update(
    scope: Scope,
    cwd: string,
    env: NodeJS.ProcessEnv = process.env,
    names: string[] = [],
  ): Promise<ProcessResult> {
    try {
      return await this.invoke(
        [
          "skills",
          "update",
          ...names,
          scope === "global" ? "--global" : "--project",
          "--yes",
        ],
        {
          cwd,
          env,
        },
      );
    } catch (error) {
      throw new SkillsExecutionError(
        `skills update failed to start: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }
}
