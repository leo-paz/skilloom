import { dirname } from "node:path";
import { GitAdapter } from "../adapters/git.js";
import { isLinkedWorktree } from "../adapters/project.js";
import {
  findProjectRoot,
  loadInventorySnapshot,
  loadMachineId,
  loadUserConfig,
  resolveConfigPaths,
  saveUserConfig,
} from "../core/config.js";
import { normalizeRemote } from "../core/inventory.js";
import { isValidSkillSource } from "../core/schema.js";
import type { SkillRequirement, UserConfig } from "../core/types.js";
import { editProject } from "./configuration.js";
import { loadCurrentInventory } from "./inventory.js";
import type { CliRuntime } from "./runtime.js";

type PolicyCommand = "add" | "edit" | "move" | "remove";

interface PolicyTarget {
  kind: "profile" | "project";
  name: string;
  skills: SkillRequirement[];
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--"))
    throw new Error(`${name} requires a value`);
  return value;
}

function identifier(value: string, label: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    throw new Error(`${label} must be a plain identifier`);
  }
  return value;
}

function target(
  config: UserConfig,
  value: string,
  create: boolean,
): PolicyTarget {
  const separator = value.indexOf(":");
  const kind = value.slice(0, separator);
  const name = value.slice(separator + 1);
  if (!name || (kind !== "profile" && kind !== "project")) {
    throw new Error("target must be profile:NAME or project:ID");
  }
  if (kind === "profile") {
    const profile = config.profiles[name];
    if (!profile) throw new Error(`profile ${name} does not exist`);
    return { kind, name, skills: profile.skills };
  }
  const matchingProjects = Object.keys(config.projects).filter((projectId) => {
    const normalized = projectId.replace(/\.git$/i, "");
    const shortName = normalized.startsWith("local:")
      ? normalized.split(":")[1]
      : normalized.split("/").at(-1);
    return projectId === name || shortName === name;
  });
  if (matchingProjects.length > 1) {
    throw new Error(
      `project name ${name} is ambiguous; use its full project ID`,
    );
  }
  const projectId = matchingProjects[0] ?? name;
  if (!config.projects[projectId] && create)
    config.projects[projectId] = { skills: [] };
  const project = config.projects[projectId];
  if (!project) throw new Error(`project policy ${name} does not exist`);
  return { kind, name: projectId, skills: project.skills };
}

function agents(args: string[]): string[] | undefined {
  const value = option(args, "--agents") || option(args, "--agent");
  if (!value) return undefined;
  const parsed = [
    ...new Set(
      value
        .split(",")
        .filter(Boolean)
        .map((agent) => identifier(agent.trim(), "agent")),
    ),
  ].sort();
  if (parsed.length === 0) throw new Error("at least one agent is required");
  return parsed;
}

async function pullManaged(
  config: UserConfig,
  path: string,
): Promise<UserConfig> {
  if (config.storage.mode !== "managed") return config;
  await new GitAdapter().pull(dirname(path));
  return loadUserConfig(path);
}

export async function editPolicy(
  command: PolicyCommand,
  args: string[],
  runtime: CliRuntime,
  json: boolean,
): Promise<number> {
  const skillNames = args
    .slice(
      0,
      args.findIndex((argument) => argument.startsWith("--")) === -1
        ? args.length
        : args.findIndex((argument) => argument.startsWith("--")),
    )
    .map((name) => identifier(name, "skill name"));
  const skillName = skillNames[0];
  if (!skillName) throw new Error(`${command} requires a skill name`);
  if (command !== "add" && skillNames.length !== 1) {
    throw new Error(`${command} accepts exactly one skill name`);
  }
  if (args.includes("--shared")) {
    if (
      command !== "add" ||
      !args.includes("--project") ||
      option(args, "--to")
    ) {
      throw new Error("--shared requires add --project without --to");
    }
    if (skillNames.length !== 1)
      throw new Error("shared project add accepts one skill at a time");
    const requestedAgents = agents(args);
    const source = option(args, "--source");
    if (!source) throw new Error("add requires --source");
    return editProject(
      "add",
      [
        "--skill",
        skillName,
        "--source",
        source,
        "--agents",
        requestedAgents?.join(",") ?? "codex",
      ],
      runtime,
      json,
    );
  }
  const paths = resolveConfigPaths(runtime.env, option(args, "--config"));
  let config = await pullManaged(
    await loadUserConfig(paths.configPath),
    paths.configPath,
  );
  let sourceTarget = option(args, command === "edit" ? "--in" : "--from");
  let destinationTarget = option(args, "--to");
  const resolveTarget = async (
    value: string | undefined,
  ): Promise<string | undefined> => {
    if (!value?.startsWith("project:")) return value;
    const name = value.slice("project:".length);
    if (name.includes("/") || name.startsWith("local:")) return value;
    const snapshot =
      (await loadInventorySnapshot(paths.inventoryPath)) ??
      (await loadCurrentInventory(runtime, option(args, "--config")));
    const ids = new Set([
      ...Object.keys(config.projects),
      ...snapshot.projects.map((project) => project.id),
    ]);
    const matches = [...ids].filter(
      (id) =>
        id === name ||
        id
          .replace(/\.git$/i, "")
          .split("/")
          .at(-1) === name ||
        (id.startsWith("local:") && id.split(":")[1] === name),
    );
    if (matches.length !== 1)
      throw new Error(
        matches.length > 1
          ? `project name ${name} is ambiguous; use its full project ID`
          : `project ${name} was not discovered; run setup or use its full project ID`,
      );
    return `project:${matches[0]}`;
  };
  sourceTarget = await resolveTarget(sourceTarget);
  destinationTarget = await resolveTarget(destinationTarget);
  if (args.includes("--project")) {
    if (command !== "add" || destinationTarget)
      throw new Error("--project requires add without --to");
    const root = findProjectRoot(runtime.cwd);
    if (!root) throw new Error("--project must run inside a Git repository");
    if (await isLinkedWorktree(root))
      throw new Error(
        "--project cannot enroll a linked worktree; run it from an independent clone",
      );
    const remote = await runtime.run(
      "git",
      ["config", "--get", "remote.origin.url"],
      { cwd: root, env: runtime.env },
    );
    if (remote.code !== 0 || !remote.stdout.trim())
      throw new Error(
        "--project requires an origin remote to identify this repository across machines",
      );
    destinationTarget = `project:${normalizeRemote(remote.stdout.trim())}`;
  }
  if (command === "add" && !destinationTarget) {
    const id = await loadMachineId(paths.machineIdPath);
    const profile = config.machines[id]?.profile;
    if (!profile)
      throw new Error("current machine has no profile; run skilloom setup");
    destinationTarget = `profile:${profile}`;
  }
  let from: PolicyTarget | undefined;
  let to: PolicyTarget | undefined;
  let requirement: SkillRequirement | undefined;

  if (command === "add") {
    if (!destinationTarget) throw new Error("add requires --to");
    to = target(config, destinationTarget, true);
    const source = option(args, "--source");
    if (!source || !isValidSkillSource(source)) {
      throw new Error("add requires a valid --source");
    }
    const targetAgents = agents(args) ?? ["codex"];
    for (const name of skillNames) {
      if (to.skills.some((skill) => skill.name === name)) {
        throw new Error(`${to.kind} ${to.name} already contains ${name}`);
      }
    }
    for (const name of skillNames) {
      const added = { name, source, agents: [...targetAgents] };
      to.skills.push(added);
      requirement ??= added;
    }
  } else {
    if (!sourceTarget)
      throw new Error(
        `${command} requires ${command === "edit" ? "--in" : "--from"}`,
      );
    from = target(config, sourceTarget, false);
    const index = from.skills.findIndex((skill) => skill.name === skillName);
    if (index === -1)
      throw new Error(
        `${from.kind} ${from.name} does not contain ${skillName}`,
      );
    const existing = from.skills[index];
    if (!existing) throw new Error(`skill ${skillName} is unavailable`);
    requirement = { ...existing, agents: [...existing.agents] };
    if (command === "edit") {
      const nextSource = option(args, "--source");
      const nextAgents = agents(args);
      if (!nextSource && !nextAgents)
        throw new Error("edit requires --source or --agents");
      if (nextSource) {
        if (!isValidSkillSource(nextSource))
          throw new Error("source contains unsafe characters");
        requirement.source = nextSource;
      }
      if (nextAgents) requirement.agents = nextAgents;
      from.skills[index] = requirement;
    } else {
      from.skills.splice(index, 1);
      if (command === "move") {
        if (!destinationTarget) throw new Error("move requires --to");
        to = target(config, destinationTarget, true);
        if (to.skills.some((skill) => skill.name === skillName)) {
          throw new Error(
            `${to.kind} ${to.name} already contains ${skillName}`,
          );
        }
        to.skills.push(requirement);
      }
    }
  }

  await saveUserConfig(paths.configPath, config);
  if (config.storage.mode === "managed") {
    await new GitAdapter().commitAndPush(
      dirname(paths.configPath),
      `${command[0]?.toUpperCase()}${command.slice(1)} ${skillNames.join(", ")}`,
    );
  }
  const change = {
    skill: skillName,
    skills: skillNames,
    ...(from ? { from: `${from.kind}:${from.name}` } : {}),
    ...(to ? { to: `${to.kind}:${to.name}` } : {}),
    requirement,
  };
  runtime.stdout(
    json
      ? JSON.stringify({ ok: true, command, change })
      : `${command} ${skillNames.join(", ")}${to ? ` in ${to.kind} ${to.name}` : ""}`,
  );
  return 0;
}
