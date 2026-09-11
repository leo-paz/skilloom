import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import type { ProjectConfig, SkillRequirement, UserConfig } from "./types.js";

const identifier = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "must be a plain identifier");

export function isLocalSkillSource(value: string): boolean {
  return (
    value.startsWith("/") ||
    value.startsWith("~/") ||
    value.startsWith("./") ||
    value.startsWith("../") ||
    value.startsWith("file:") ||
    /^[A-Za-z]:[\\/]/.test(value)
  );
}

export function isValidSkillSource(value: string): boolean {
  const local = isLocalSkillSource(value);
  if (local) return value.length <= 2048 && /^[^\0\r\n]+$/.test(value);
  return /^[A-Za-z0-9@._~:/+-]+$/.test(value) && value.length <= 2048;
}

const source = z
  .string()
  .min(1)
  .max(2048)
  .refine(isValidSkillSource, "source contains unsafe characters");

const skillSchema = z
  .object({
    source,
    name: identifier,
    agents: z.array(identifier).min(1).default(["codex"]),
  })
  .strict();

function uniqueSkills(
  skills: SkillRequirement[],
  context: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  for (const skill of skills) {
    const key = `${skill.source}:${skill.name}:${[...skill.agents].sort().join(",")}`;
    if (seen.has(key)) {
      context.addIssue({
        code: "custom",
        message: `duplicate skill ${skill.name}`,
      });
    }
    seen.add(key);
  }
}

const profileSchema = z
  .object({ skills: z.array(skillSchema).default([]) })
  .strict()
  .superRefine((profile, context) => uniqueSkills(profile.skills, context));

const storageSchema = z
  .object({
    mode: z.enum(["local", "external", "managed"]).default("local"),
    path: z.string().min(1).optional(),
    repository: source.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.mode === "managed" && !value.repository) {
      context.addIssue({
        code: "custom",
        message: "managed storage requires repository",
      });
    }
  });

const userConfigSchema = z
  .object({
    version: z.union([z.literal(1), z.literal(2)]),
    ownershipReleases: z
      .array(
        z
          .object({
            id: z.string().regex(/^[a-f0-9]{64}$/),
            projectId: z.string().min(1),
            name: identifier,
          })
          .strict(),
      )
      .optional(),
    storage: storageSchema.default({ mode: "local" }),
    profiles: z.record(identifier, profileSchema),
    machines: z.record(
      identifier,
      z
        .object({
          profile: identifier,
          name: z.string().min(1).max(128).optional(),
        })
        .strict(),
    ),
    projectProfiles: z.record(identifier, profileSchema).default({}),
    projects: z
      .record(
        z.string().min(1),
        z
          .object({
            profile: identifier.optional(),
            skills: z.array(skillSchema).default([]),
          })
          .strict()
          .superRefine((project, context) =>
            uniqueSkills(project.skills, context),
          ),
      )
      .default({}),
  })
  .strict()
  .superRefine((config, context) => {
    if (config.ownershipReleases?.length && config.version !== 2)
      context.addIssue({
        code: "custom",
        message:
          "ownership releases require configuration version 2; upgrade Skilloom on participating machines",
      });
  });

const projectConfigSchema = z
  .object({
    version: z.literal(1),
    profile: identifier.optional(),
    skills: z.array(skillSchema).default([]),
  })
  .strict()
  .superRefine((project, context) => uniqueSkills(project.skills, context));

function parseDocument(text: string, label: string): unknown {
  try {
    return parseYaml(text);
  } catch (error) {
    throw new Error(
      `${label}: invalid YAML: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function formatZodError(error: z.ZodError, label: string): Error {
  const issues = error.issues
    .map((issue) => `${issue.path.join(".") || "root"}: ${issue.message}`)
    .join("; ");
  return new Error(`${label}: ${issues}`);
}

export function parseUserConfig(
  text: string,
  label = "Skilloom config",
): UserConfig {
  const result = userConfigSchema.safeParse(parseDocument(text, label));
  if (!result.success) throw formatZodError(result.error, label);
  return result.data;
}

export function parseProjectConfig(
  text: string,
  label = ".skilloom.yaml",
): ProjectConfig {
  const result = projectConfigSchema.safeParse(parseDocument(text, label));
  if (!result.success) throw formatZodError(result.error, label);
  return result.data;
}

export function serializeUserConfig(config: UserConfig): string {
  return stringifyYaml(config, { sortMapEntries: true, lineWidth: 100 });
}

export function serializeProjectConfig(config: ProjectConfig): string {
  return stringifyYaml(config, { sortMapEntries: true, lineWidth: 100 });
}
