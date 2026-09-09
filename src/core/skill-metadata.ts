import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseDocument } from "yaml";
import { z } from "zod";
import type { Scope } from "./types.js";

const skillInvocationSchema = z.enum([
  "manual",
  "automatic",
  "both",
  "disabled",
  "mixed",
  "unknown",
]);
export type SkillInvocation = z.infer<typeof skillInvocationSchema>;
/** Published declaration facts only; never includes local paths or skill instructions. */
export const skillMetadataSchema = z.object({
  source: z.literal("skill-declaration"),
  invocation: skillInvocationSchema,
  variants: z
    .array(
      z.object({
        agent: z.string().min(1).max(128),
        invocation: skillInvocationSchema,
        status: z.enum(["read", "missing", "invalid", "unsupported"]),
      }),
    )
    .max(128),
});
/** Harness overrides, permissions, runtime configuration and actual usage are not inspected. */
export type SkillMetadata = z.infer<typeof skillMetadataSchema>;
export interface SkillMetadataInput {
  name: string;
  scope: Scope;
  agents: string[];
  detectedAgents?: string[] | undefined;
  path?: string | undefined;
}
type FileResult =
  | { status: "read"; text: string; canonical: string; truncated: boolean }
  | { status: "missing" | "invalid" };
const maximumBytes = 64 * 1024;

function document(text: string): Record<string, unknown> | undefined {
  try {
    const parsed = parseDocument(text, { uniqueKeys: true });
    if (parsed.errors.length) return undefined;
    const value: unknown = parsed.toJS({ maxAliasCount: 0 });
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}
function combine(values: SkillInvocation[]): SkillInvocation {
  if (!values.length || values.includes("unknown")) return "unknown";
  return new Set(values).size === 1 ? values[0]! : "mixed";
}
function booleanField(value: unknown, fallback: boolean): boolean | undefined {
  return value === undefined
    ? fallback
    : typeof value === "boolean"
      ? value
      : undefined;
}

/** Construct once per inventory scan. Cached reads are bounded and shared across symlink aliases. */
export function createSkillMetadataReader(env: NodeJS.ProcessEnv) {
  const files = new Map<string, Promise<FileResult>>();
  const aliases = new Map<string, Promise<FileResult>>();
  const read = (path: string): Promise<FileResult> => {
    const existing = aliases.get(path);
    if (existing) return existing;
    const request = (async (): Promise<FileResult> => {
      let canonical: string;
      try {
        canonical = await realpath(path);
      } catch (error) {
        return {
          status:
            (error as NodeJS.ErrnoException).code === "ENOENT"
              ? "missing"
              : "invalid",
        };
      }
      let cached = files.get(canonical);
      if (!cached) {
        cached = (async (): Promise<FileResult> => {
          try {
            // Nonblocking open avoids hanging on a substituted FIFO; special files never get read.
            const handle = await open(
              canonical,
              constants.O_RDONLY | constants.O_NONBLOCK,
            );
            try {
              if (!(await handle.stat()).isFile()) return { status: "invalid" };
              const buffer = Buffer.alloc(maximumBytes + 1);
              const { bytesRead } = await handle.read(
                buffer,
                0,
                buffer.length,
                0,
              );
              return {
                status: "read",
                truncated: bytesRead > maximumBytes,
                text: buffer.subarray(0, bytesRead).toString("utf8"),
                canonical,
              };
            } finally {
              await handle.close();
            }
          } catch {
            return { status: "invalid" };
          }
        })();
        files.set(canonical, cached);
      }
      return cached;
    })();
    aliases.set(path, request);
    return request;
  };

  return async (
    skill: SkillMetadataInput,
    cwd: string,
  ): Promise<SkillMetadata> => {
    const variants: SkillMetadata["variants"] = [];
    const inputAgents = skill.detectedAgents?.length
      ? skill.detectedAgents
      : skill.agents;
    const agents = [
      ...new Set(
        inputAgents.map((agent) =>
          agent === "Claude Code" ? "claude-code" : agent.toLowerCase(),
        ),
      ),
    ].sort();
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/.test(skill.name) ||
      agents.length > 128 ||
      agents.some((agent) => !agent || agent.length > 128)
    )
      return {
        source: "skill-declaration",
        invocation: "unknown",
        variants: [],
      };
    for (const agent of agents) {
      if (!["claude-code", "codex", "pi"].includes(agent)) {
        variants.push({ agent, invocation: "unknown", status: "unsupported" });
        continue;
      }
      const base = skill.scope === "project" ? cwd : env.HOME;
      const directories: string[] = [];
      if (skill.path) directories.push(resolve(cwd, skill.path));
      if (base) {
        if (agent === "claude-code")
          directories.push(
            join(
              skill.scope === "global" && env.CLAUDE_CONFIG_DIR
                ? env.CLAUDE_CONFIG_DIR
                : join(base, ".claude"),
              "skills",
              skill.name,
            ),
          );
        else {
          directories.push(join(base, ".agents", "skills", skill.name));
          directories.push(
            agent === "codex"
              ? join(
                  skill.scope === "global" && env.CODEX_HOME
                    ? env.CODEX_HOME
                    : join(base, ".codex"),
                  "skills",
                  skill.name,
                )
              : join(
                  base,
                  ".pi",
                  ...(skill.scope === "global" ? ["agent"] : []),
                  "skills",
                  skill.name,
                ),
          );
        }
      }
      const observed: SkillInvocation[] = [];
      let invalid = false;
      const seen = new Set<string>();
      for (const directory of [...new Set(directories)]) {
        const result = await read(join(directory, "SKILL.md"));
        if (result.status === "missing") continue;
        if (result.status !== "read") {
          invalid = true;
          continue;
        }
        // Sidecars resolve beside each visible installation, even when SKILL.md is a link.
        const identity = `${result.canonical}:${agent === "codex" ? directory : ""}`;
        if (seen.has(identity)) continue;
        seen.add(identity);
        const frontmatter = result.text.match(
          /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/,
        )?.[1];
        const fields =
          frontmatter === undefined ? undefined : document(frontmatter);
        if (
          !fields ||
          (fields.name !== undefined && fields.name !== skill.name)
        ) {
          invalid = true;
          continue;
        }
        if (agent === "codex") {
          // https://learn.chatgpt.com/docs/build-skills#optional-metadata
          // Claude's frontmatter invocation flags are not Codex policy.
          const sidecar = await read(join(directory, "agents", "openai.yaml"));
          let implicit: boolean | undefined = true;
          if (sidecar.status === "invalid") implicit = undefined;
          if (sidecar.status === "read") {
            const metadata = !sidecar.truncated
              ? document(sidecar.text)
              : undefined;
            const policy = metadata?.policy;
            if (
              !metadata ||
              (policy !== undefined &&
                (!policy ||
                  typeof policy !== "object" ||
                  Array.isArray(policy)))
            )
              implicit = undefined;
            else
              implicit = booleanField(
                (policy as Record<string, unknown> | undefined)
                  ?.allow_implicit_invocation,
                true,
              );
          }
          if (implicit === undefined) invalid = true;
          else observed.push(implicit ? "both" : "manual");
        } else {
          // Claude: https://code.claude.com/docs/en/skills#control-who-invokes-a-skill
          // Pi: https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/skills.md
          // Pi ignores user-invocable; command enablement is a separate runtime setting.
          const automatic = booleanField(
            fields["disable-model-invocation"],
            false,
          );
          const manual =
            agent === "pi"
              ? true
              : booleanField(fields["user-invocable"], true);
          if (
            automatic === undefined ||
            manual === undefined ||
            (agent === "pi" &&
              (typeof fields.description !== "string" ||
                !fields.description.trim()))
          )
            invalid = true;
          else
            observed.push(
              automatic
                ? manual
                  ? "manual"
                  : "disabled"
                : manual
                  ? "both"
                  : "automatic",
            );
        }
      }
      variants.push({
        agent,
        invocation: invalid ? "unknown" : combine(observed),
        status: invalid ? "invalid" : observed.length ? "read" : "missing",
      });
    }
    return {
      source: "skill-declaration",
      invocation: combine(
        variants
          .filter(
            (variant) =>
              variant.status === "read" || variant.status === "invalid",
          )
          .map((variant) => variant.invocation),
      ),
      variants,
    };
  };
}
