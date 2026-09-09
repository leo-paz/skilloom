import { resolve } from "node:path";
import { SkillsAdapter } from "../adapters/skills.js";
import { verifyProvenance } from "../core/provenance.js";
import type { Scope } from "../core/types.js";
import type { CliRuntime } from "./runtime.js";

export async function verifySource(
  args: string[],
  runtime: CliRuntime,
  json: boolean,
): Promise<number> {
  const name = args[0];
  if (!name || name.startsWith("--"))
    throw new Error("source verify requires a skill name");
  const option = (flag: string): string | undefined => {
    const index = args.indexOf(flag);
    if (index === -1) return undefined;
    const value = args[index + 1];
    if (!value || value.startsWith("--"))
      throw new Error(`${flag} requires a value`);
    return value;
  };
  const source = option("--source");
  if (!source) throw new Error("source verify requires --source owner/repo");
  const scope = option("--scope") ?? "global";
  if (scope !== "global" && scope !== "project")
    throw new Error("--scope must be global or project");
  const cwd = resolve(runtime.cwd, option("--checkout") ?? runtime.cwd);
  const skills = await new SkillsAdapter(runtime.run).list(
    scope as Scope,
    cwd,
    runtime.env,
  );
  const matches = skills.filter(
    (skill) => skill.name === name && skill.scope === scope,
  );
  if (matches.length !== 1)
    throw new Error(
      `Expected exactly one installed ${scope} skill named ${name}; found ${matches.length}`,
    );
  const dryRun = args.includes("--dry-run");
  if (
    !dryRun &&
    !args.includes("--yes") &&
    (!runtime.isTTY ||
      !(await runtime.confirm(
        `Verify and record ${source} as the source of ${name}?`,
      )))
  ) {
    runtime.stdout(
      json
        ? JSON.stringify({
            ok: false,
            command: "source verify",
            canceled: true,
          })
        : "Source verification canceled. Pass --yes to save verified provenance or --dry-run to inspect.",
    );
    return 5;
  }
  const result = await verifyProvenance(matches[0]!, source, cwd, runtime.env, {
    persist: !dryRun,
  });
  runtime.stdout(
    json
      ? JSON.stringify({
          ok: true,
          command: "source verify",
          dryRun,
          ...result,
        })
      : `${name}: installed contents match ${source}${dryRun ? "; no provenance saved" : "; verified provenance saved"}.`,
  );
  return 0;
}
