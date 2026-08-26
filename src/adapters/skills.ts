import { spawn } from "node:child_process";
import { z } from "zod";
import type { InstalledSkill, PlanOperation, Scope } from "../core/types.js";

const upstreamSkill = z
  .object({
    name: z.string().min(1),
    scope: z.enum(["global", "project"]),
    agents: z.array(z.string()),
    source: z.string().nullable().optional(),
    sourceUrl: z.string().nullable().optional(),
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
    source: skill.source ?? skill.sourceUrl ?? null,
    scope: skill.scope,
    agents: skill.agents.map(
      (agent) =>
        agentAliases[agent] ?? agent.toLowerCase().replaceAll(" ", "-"),
    ),
  }));
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
      stdio: ["ignore", "pipe", "pipe"],
    });
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
    child.once("error", reject);
    child.once("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });

export class SkillsAdapter {
  constructor(
    private readonly runner: ProcessRunner = runProcess,
    private readonly executable = "npx",
  ) {}

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
      result = await this.runner(this.executable, args, { cwd, env });
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
    return parseSkillsList(result.stdout);
  }

  async execute(
    operation: PlanOperation,
    cwd: string,
    env: NodeJS.ProcessEnv = process.env,
    output: Pick<ProcessOptions, "onStdout" | "onStderr"> = {},
  ): Promise<ProcessResult> {
    try {
      return await this.runner(
        this.executable,
        commandForOperation(operation),
        {
          cwd,
          env,
          ...output,
        },
      );
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
      return await this.runner(
        this.executable,
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
