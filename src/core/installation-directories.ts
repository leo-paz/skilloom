import { posix, win32 } from "node:path";
import { z } from "zod";

const relativeDirectory = z
  .string()
  .max(4096)
  .refine(
    (value) =>
      !/[\\\x00-\x1f\x7f:]/.test(value) &&
      !value.startsWith("/") &&
      value.split("/").every((part) => part !== ".." && part !== "."),
  );
export const installationDirectorySchema = z
  .object({
    base: z.enum([
      "home",
      "project",
      "CODEX_HOME",
      "CLAUDE_CONFIG_DIR",
      "PI_CODING_AGENT_DIR",
      "external",
    ]),
    path: relativeDirectory,
  })
  .refine((value) => value.base !== "external" || value.path === "");
export type InstallationDirectory = z.infer<typeof installationDirectorySchema>;

/** Produce a shareable path on the origin machine. Never serialize an absolute
 * home, checkout, custom root or symlink target into the shared repository. */
export function installationDirectory(
  directory: string,
  cwd: string | undefined,
  env: NodeJS.ProcessEnv,
): InstallationDirectory {
  const paths = /^(?:[a-z]:[\\/]|\\\\)/i.test(directory) ? win32 : posix;
  const roots: Array<[InstallationDirectory["base"], string | undefined]> = [
    ["project", cwd],
    ["home", env.HOME || env.USERPROFILE],
    ["CODEX_HOME", env.CODEX_HOME?.trim()],
    ["CLAUDE_CONFIG_DIR", env.CLAUDE_CONFIG_DIR?.trim()],
    ["PI_CODING_AGENT_DIR", env.PI_CODING_AGENT_DIR?.trim()],
  ];
  for (const [base, root] of roots) {
    if (!root || !paths.isAbsolute(root)) continue;
    const relative = paths.relative(root, directory);
    if (
      paths.isAbsolute(relative) ||
      relative === ".." ||
      relative.startsWith(`..${paths.sep}`)
    )
      continue;
    const result = installationDirectorySchema.safeParse({
      base,
      path: relative.split(paths.sep).join("/"),
    });
    if (result.success) return result.data;
  }
  return { base: "external", path: "" };
}

export function installationDirectoryLabel(
  directory: InstallationDirectory,
): string {
  if (directory.base === "external") return "Custom directory (path private)";
  const prefix =
    directory.base === "home"
      ? "~"
      : directory.base === "project"
        ? "."
        : `<${directory.base}>`;
  return directory.path ? `${prefix}/${directory.path}` : prefix;
}
