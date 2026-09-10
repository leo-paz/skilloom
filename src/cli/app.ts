import { defineCommand } from "citty";
import packageMetadata from "../../package.json" with { type: "json" };
import { GitExecutionError } from "../adapters/git.js";
import {
  redactProcessOutput,
  SkillsAdapter,
  SkillsExecutionError,
} from "../adapters/skills.js";
import { findProjectRoot } from "../core/config.js";
import {
  configureProfiles,
  editProject,
  initializeConfiguration,
  initializeProject,
} from "./configuration.js";
import { connectConfiguration } from "./connect.js";
import { doctor } from "./doctor.js";
import { showInventory } from "./inventory.js";
import { migrateConfiguration } from "./migrate.js";
import { observeMachine } from "./observe.js";
import { editPolicy } from "./policy.js";
import { applyReconciliation, showReconciliation } from "./reconcile.js";
import { type CliRuntime, defaultRuntime } from "./runtime.js";
import { setupMachine } from "./setup.js";
import { verifySource } from "./source.js";
import { syncMachine } from "./sync.js";
import { usageCommand } from "./usage.js";
import {
  applyWorkspacePlan,
  showWorkspacePlan,
} from "./workspace-reconcile.js";

export { type CliRuntime, defaultRuntime };

const version = packageMetadata.version;

const help = `Skilloom ${version}

Usage: skilloom <command> [options]

Commands:
  skilloom tui              Open the full-screen skill library
  skilloom usage            Collect local skill history and configure usage hooks
  skilloom migrate          Review and repair legacy adoption policy
  skilloom source verify    Verify an installed skill's source without reinstalling
  skilloom setup [DIR]      Discover projects and adopt existing skills
  skilloom connect REPO     Connect existing configuration to shared Git storage
  skilloom sync             Reconcile this machine and publish its status
  skilloom inventory        Show machines, projects, skills, and drift
  skilloom add NAME...      Add desired policy atomically
  skilloom edit NAME        Edit desired policy atomically
  skilloom move NAME        Move desired policy atomically
  skilloom remove NAME      Remove desired policy atomically
  skilloom observe          Save or publish the current inventory
  skilloom init             Initialize user configuration
  skilloom plan             Show desired changes
  skilloom apply            Apply desired changes through the pinned skills CLI
  skilloom status           Show convergence status
  skilloom update           Update managed skills
  skilloom project init     Create .skilloom.yaml
  skilloom project add      Add a project requirement
  skilloom project remove   Remove a project requirement
  skilloom config           Manage profiles and machine selection
  skilloom doctor           Diagnose the local setup

Common options:
  --json                    Emit machine-readable output
  --config <path>           Use an explicit user configuration
  --yes                     Confirm a mutating command
  --help                    Show command help
  --version                 Show the version

Exit codes: 0 success, 1 migration preview blocker, 2 drift or unresolved verification,
            3 invalid/unavailable state, 4 execution/diagnostic failure, 5 cancellation or changed sync plan`;

const commandHelp: Record<string, string> = {
  doctor: `Usage: skilloom doctor [--installations] [--json] [--config PATH]

Check runtime, dependencies and configuration. With --installations, inspect local installation entries without changing files, scanning logs, or contacting other machines. Exit 0 means the bounded scan completed within its stated scope, even with findings; exit 4 means inspection was incomplete.`,
  usage: `Usage: skilloom usage status|install|uninstall|refresh|backfill [--once] [--restart] [--max-seconds 1..180]|publish [--dry-run]

Install hooks locally, refresh recent evidence, or resume history backfill. Backfill checkpoints after two minutes by default; run it again to continue. Ctrl-C pauses safely. Preview sharing with usage publish --dry-run, then publish with usage publish.`,
  tui: `Usage: skilloom [tui] [--config PATH]

Open a full-screen skill library. Search with /, switch views with 1–3 or Tab, inspect with Enter, check local installations with l, refresh with r, and review sync with s. Press ? for all keys.`,
  migrate: `Usage: skilloom migrate [--dry-run] [--yes] [--expect FINGERPRINT] [--json]

Review obsolete adoption requirements and ownership records with --dry-run. Apply with --yes and optionally --expect using preview.fingerprint from the dry run. A changed fingerprint refuses application. Migration preserves installed files and backs up configuration and state.`,
  source: `Usage: skilloom source verify NAME --source REPOSITORY [--scope global|project] [--checkout PATH] [--dry-run|--yes] [--json]

Compare installed files with the source repository and save verified local provenance. Does not reinstall or adopt a skill.`,
  config: `Usage: skilloom config [--add-profile NAME [--copy-profile BASE]] [--profile NAME] [--json]

Create/copy profiles or change this machine's assignment. Review sync before applying installations.`,
  connect: `Usage: skilloom connect REPOSITORY [--json]

Connect local configuration to a shared Git repository, preserving machine identity and a local backup. Conflicting configuration entries require resolution.`,
  sync: `Usage: skilloom sync [--dry-run] [--yes] [--expect FINGERPRINT] [--json]

Pull shared policy, reconcile local installations, verify, and publish status. Use --expect with the fingerprint from --dry-run --json to apply the reviewed plan; a changed plan returns exit 5. JSON separates apply, verify, and publish phases and reports partial success. Linked worktrees and repository-owned skill files are excluded from mutation. Does not upgrade skill revisions or pull project repositories.`,
  setup: `Usage: skilloom setup [WORKSPACE] [options]

Discover Git projects, inspect existing installations through the skills CLI, and adopt eligible skills without reinstalling them.

Options:
  --depth <1-8>             Maximum project discovery depth, default 3
  --machine-name <name>     Human-readable name for this machine
  --profile <name>          Assign an existing global profile
  --preserve-global-profile <name>  Adopt current globals into a new exclusive profile
  --storage <mode>          local, external, or managed
  --repository <url>        Managed Git configuration repository
  --sync <url>              Shorthand for managed Git storage
  --no-adopt                Keep existing installations unmanaged
  --json                    Emit the complete setup inventory`,
  inventory: `Usage: skilloom inventory [--cached] [--machine ID|NAME] [--scope global|project] [--source SOURCE|unknown] [--ownership repository|personal|unknown] [--query TEXT] [--json]

Inspect local and published remote occurrences. Cached mode never scans or contacts Git. Remote records always carry observation timestamps. Filters apply to records; the full inventory remains available for compatibility.`,
  add: `Usage: skilloom add NAME... --source SOURCE [options]

Options:
  --to <target>            Explicit profile:NAME or project:ID; default current profile
  --project                Personal requirement for the current repository
  --shared                 With --project, write the repository's .skilloom.yaml
  --agent <name>            Target agent, default codex
  --agents <a,b>            Target several agents
  --json                    Emit the saved policy change`,
  edit: `Usage: skilloom edit NAME --in profile:NAME|project:ID [options]

Options:
  --source <source>         Replace the skill source
  --agents <a,b>            Replace target agents
  --json                    Emit the saved policy change`,
  move: `Usage: skilloom move NAME --from profile:NAME|project:ID --to profile:NAME|project:ID [--json]`,
  remove: `Usage: skilloom remove NAME --from profile:NAME|project:ID [--json]`,
  observe: `Usage: skilloom observe [--publish] [--json]

Refresh local installed state. Publishing requires managed Git storage and never applies changes.`,
  plan: `Usage: skilloom plan [--all] [--check] [--json]`,
  apply: `Usage: skilloom apply [--all] [--yes] [--json]`,
  update: `Usage: skilloom update [NAME] [--scope global|project] [--yes] [--json]`,
};

export const commandContract = defineCommand({
  meta: {
    name: "skilloom",
    version,
    description: "Reconcile Agent Skills through the skills CLI",
  },
  subCommands: Object.fromEntries(
    [
      "tui",
      "usage",
      "migrate",
      "source",
      "init",
      "setup",
      "connect",
      "sync",
      "inventory",
      "add",
      "edit",
      "move",
      "remove",
      "observe",
      "plan",
      "apply",
      "status",
      "update",
      "project",
      "config",
      "doctor",
    ].map((name) => [name, defineCommand({ meta: { name } })]),
  ),
});

function flag(args: string[], name: string): boolean {
  return args.includes(name);
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--"))
    throw new Error(`${name} requires a value`);
  return value;
}

function emit(
  runtime: CliRuntime,
  json: boolean,
  command: string,
  data: Record<string, unknown>,
  text: string,
): void {
  runtime.stdout(json ? JSON.stringify({ ok: true, command, ...data }) : text);
}

function emitError(
  runtime: CliRuntime,
  json: boolean,
  code: string,
  message: string,
): void {
  runtime.stderr(
    json
      ? JSON.stringify({ ok: false, error: { code, message } })
      : `Error: ${message}`,
  );
}

async function update(
  args: string[],
  runtime: CliRuntime,
  json: boolean,
): Promise<number> {
  if (!flag(args, "--yes") && !runtime.isTTY) {
    emit(
      runtime,
      json,
      "update",
      { canceled: true },
      "Refusing to prompt outside a terminal. Pass --yes to update.",
    );
    return 5;
  }
  if (
    !flag(args, "--yes") &&
    !(await runtime.confirm("Update project and global skills?"))
  )
    return 5;
  const adapter = new SkillsAdapter(runtime.run);
  const root = findProjectRoot(runtime.cwd) || runtime.cwd;
  const scopeValue = option(args, "--scope");
  if (scopeValue && scopeValue !== "global" && scopeValue !== "project") {
    throw new Error("--scope must be global or project");
  }
  const name = args[0] && !args[0].startsWith("--") ? args[0] : undefined;
  const scopes = scopeValue
    ? [scopeValue as "global" | "project"]
    : (["project", "global"] as const);
  const results = [];
  for (const scope of scopes) {
    results.push(
      await adapter.update(scope, root, runtime.env, name ? [name] : []),
    );
  }
  const failure = results.find((result) => result.code !== 0);
  if (failure)
    throw new SkillsExecutionError(
      redactProcessOutput(failure.stderr, runtime.env).trim() ||
        `skills update exited ${failure.code}`,
    );
  emit(
    runtime,
    json,
    "update",
    { scopes, skills: name ? [name] : [] },
    `Updated ${name || "installed skills"} in ${scopes.join(" and ")} scope.`,
  );
  return 0;
}

export async function runCli(
  rawArgs: string[],
  runtime: CliRuntime,
): Promise<number> {
  const json = flag(rawArgs, "--json");
  try {
    if (flag(rawArgs, "--version") || flag(rawArgs, "-v")) {
      runtime.stdout(version);
      return 0;
    }
    if (rawArgs.length === 0) {
      if (runtime.isTTY) {
        const { runDashboard } = await import("../tui/dashboard.js");
        return runDashboard(runtime, runCli);
      }
      runtime.stdout(help);
      return 0;
    }
    if (flag(rawArgs, "--help") || flag(rawArgs, "-h")) {
      runtime.stdout(commandHelp[rawArgs[0] ?? ""] ?? help);
      return 0;
    }
    const command = rawArgs[0];
    if (command === "usage")
      return await usageCommand(rawArgs.slice(1), runtime);
    if (command === "tui") {
      if (!runtime.isTTY)
        throw new Error(
          "The full-screen library requires a terminal. Use inventory --cached --json for an agent or pipe.",
        );
      const { runDashboard } = await import("../tui/dashboard.js");
      return await runDashboard(
        runtime,
        runCli,
        option(rawArgs.slice(1), "--config"),
      );
    }
    if (command === "migrate")
      return await migrateConfiguration(rawArgs.slice(1), runtime, json);
    if (command === "source" && rawArgs[1] === "verify")
      return await verifySource(rawArgs.slice(2), runtime, json);
    if (command === "connect")
      return await connectConfiguration(rawArgs.slice(1), runtime, json);
    if (command === "sync")
      return await syncMachine(rawArgs.slice(1), runtime, json);
    if (command === "init")
      return await initializeConfiguration(rawArgs.slice(1), runtime, json);
    if (command === "setup")
      return await setupMachine(rawArgs.slice(1), runtime, json);
    if (command === "inventory")
      return await showInventory(
        runtime,
        json,
        option(rawArgs.slice(1), "--config"),
        inventoryOptions(rawArgs.slice(1)),
      );
    if (
      command === "add" ||
      command === "edit" ||
      command === "move" ||
      command === "remove"
    ) {
      return await editPolicy(command, rawArgs.slice(1), runtime, json);
    }
    if (command === "observe")
      return await observeMachine(rawArgs.slice(1), runtime, json);
    if (command === "plan") {
      const args = rawArgs.slice(1);
      if (flag(args, "--all"))
        return await showWorkspacePlan("plan", args, runtime, json);
      return await showReconciliation(
        "plan",
        {
          configPath: option(args, "--config"),
          check: flag(args, "--check"),
          json,
        },
        runtime,
      );
    }
    if (command === "status") {
      const args = rawArgs.slice(1);
      if (flag(args, "--all"))
        return await showWorkspacePlan("status", args, runtime, json);
      return await showReconciliation(
        "status",
        { configPath: option(args, "--config"), json },
        runtime,
      );
    }
    if (command === "apply") {
      const args = rawArgs.slice(1);
      if (flag(args, "--all"))
        return await applyWorkspacePlan(args, runtime, json);
      return await applyReconciliation(
        {
          configPath: option(args, "--config"),
          yes: flag(args, "--yes"),
          json,
        },
        runtime,
      );
    }
    if (command === "project" && rawArgs[1] === "init")
      return await initializeProject(rawArgs.slice(2), runtime, json);
    if (command === "project" && rawArgs[1] === "add")
      return await editProject("add", rawArgs.slice(2), runtime, json);
    if (command === "project" && rawArgs[1] === "remove")
      return await editProject("remove", rawArgs.slice(2), runtime, json);
    if (command === "config")
      return await configureProfiles(rawArgs.slice(1), runtime, json);
    if (command === "update")
      return await update(rawArgs.slice(1), runtime, json);
    if (command === "doctor")
      return await doctor(rawArgs.slice(1), runtime, json);
    throw new Error(`unknown command ${command || ""}`);
  } catch (error) {
    const executionFailure =
      error instanceof SkillsExecutionError ||
      error instanceof GitExecutionError;
    emitError(
      runtime,
      json,
      executionFailure ? "execution_failed" : "invalid_or_unavailable",
      error instanceof Error ? error.message : String(error),
    );
    return executionFailure ? 4 : 3;
  }
}

function inventoryOptions(
  args: string[],
): import("./inventory.js").InventoryOptions {
  const scope = option(args, "--scope");
  const ownership = option(args, "--ownership");
  if (scope && scope !== "global" && scope !== "project")
    throw new Error("--scope must be global or project");
  if (ownership && !["repository", "personal", "unknown"].includes(ownership))
    throw new Error("--ownership must be repository, personal, or unknown");
  return {
    cached: flag(args, "--cached"),
    machine: option(args, "--machine"),
    scope: scope as "global" | "project" | undefined,
    source: option(args, "--source"),
    ownership: ownership as "repository" | "personal" | "unknown" | undefined,
    query: option(args, "--query"),
  };
}
