import {
  cancel,
  intro,
  isCancel,
  note,
  outro,
  select,
  text,
} from "@clack/prompts";
import type { MachineInventory } from "../core/types.js";

function countLabel(
  count: number,
  singular: string,
  plural = `${singular}s`,
): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function skillSummary(
  skills: MachineInventory["globalSkills"],
  empty: string,
): string {
  if (skills.length === 0) return empty;
  return skills
    .map((skill) => `${skill.installed ? "●" : "○"} ${skill.name}`)
    .join(", ");
}

export function renderDashboard(inventory: MachineInventory): string {
  const lines = [
    `${inventory.machine.name} · profile ${inventory.machine.profile}`,
    `Observed ${inventory.observedAt} · refresh to check current state`,
    `Global · ${skillSummary(inventory.globalSkills, "no skills")}`,
    `Drift · ${
      inventory.operations.length === 0
        ? "no planned changes"
        : countLabel(inventory.operations.length, "pending change")
    }`,
    "",
    "Machines",
    ...inventory.machines.map((machine) =>
      machine.id === inventory.machine.id
        ? `● ${machine.name} · ${machine.profile} · this machine`
        : machine.observedAt
          ? `○ ${machine.name} · ${machine.profile} · ${countLabel(machine.projects ?? 0, "project")} · observed ${machine.observedAt}`
          : `○ ${machine.name} · ${machine.profile} · not observed`,
    ),
    "",
    "Projects",
  ];
  if (inventory.projects.length === 0) {
    lines.push("No Git projects found in the configured workspace roots");
  } else {
    for (const project of inventory.projects.slice(0, 12)) {
      lines.push(
        `${project.name} · ${countLabel(project.skills.length, "skill")} · ${countLabel(project.checkouts.length, "clone")} · ${project.operations.length === 0 ? "no planned changes" : countLabel(project.operations.length, "change")}`,
      );
    }
    if (inventory.projects.length > 12)
      lines.push(
        `${inventory.projects.length - 12} more projects · use View skills`,
      );
  }
  if (inventory.discovery.excludedWorktrees)
    lines.push(
      `${inventory.discovery.excludedWorktrees} linked worktrees excluded`,
    );
  return lines.join("\n");
}

function renderSkills(inventory: MachineInventory, projectId?: string): string {
  if (projectId) {
    const lines: string[] = [];
    const project = inventory.projects.find((item) => item.id === projectId);
    for (const checkout of project?.checkouts ?? []) {
      lines.push(
        `${inventory.machine.name} · ${checkout.path}${checkout.branch ? ` · ${checkout.branch}` : ""}${checkout.commit ? ` · ${checkout.commit.slice(0, 7)}` : ""}`,
      );
      for (const skill of checkout.skills ?? [])
        lines.push(
          `  ${skill.name} · ${skill.ownership === "repository" ? "repository-owned" : skill.managed ? "personal, managed" : "unmanaged"} · ${skill.installed ? "installed" : "missing"}${skill.conflict ? ` · ${skill.conflict}` : ""}`,
        );
    }
    for (const observation of inventory.remoteObservations ?? []) {
      const remote = observation.projects.find((item) => item.id === projectId);
      if (!remote) continue;
      lines.push(
        `${observation.machine.name} · observed ${observation.observedAt}`,
      );
      for (const skill of remote.skills)
        lines.push(
          `  ${skill.name} · ${skill.ownership === "repository" ? "repository-owned" : "personal"} · ${skill.installed ? "installed" : "missing"}`,
        );
    }
    return lines.join("\n") || "No observed skills for this project";
  }
  const lines = ["Global"];
  if (inventory.globalSkills.length === 0) lines.push("No global skills found");
  else {
    for (const skill of inventory.globalSkills) {
      lines.push(
        `${skill.installed ? "●" : "○"} ${skill.name} · ${skill.managed ? "managed" : "unmanaged"} · ${skill.agents.join(", ") || "unknown agents"}`,
      );
    }
  }
  return lines.join("\n");
}

function renderChanges(inventory: MachineInventory): string {
  if (inventory.operations.length === 0) return "No pending changes";
  return inventory.operations
    .map(
      (operation) =>
        `${operation.kind === "add" ? "+" : "-"} ${operation.skill.name} · ${operation.skill.scope}${operation.checkoutPath ? ` · ${operation.checkoutPath}` : ""}`,
    )
    .join("\n");
}

export async function runDashboard(
  load: () => Promise<MachineInventory>,
  run: (args: string[]) => Promise<number>,
): Promise<number> {
  intro("Skilloom");
  let inventory: MachineInventory;
  try {
    inventory = await load();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      !/not initialized|run skilloom setup|machine identifier is missing/i.test(
        message,
      )
    ) {
      throw error;
    }
    const workspace = await text({
      message: "Where do you keep your projects?",
      placeholder: "~/dev",
    });
    if (isCancel(workspace) || !workspace) {
      cancel("Setup canceled.");
      return 5;
    }
    const code = await run(["setup", String(workspace)]);
    if (code !== 0) return code;
    inventory = await load();
  }

  while (true) {
    note(renderDashboard(inventory), "Overview");
    const action = await select({
      message: "Choose a view or action",
      options: [
        { value: "skills", label: "View skills" },
        { value: "changes", label: "Review changes" },
        { value: "refresh", label: "Refresh inventory" },
        { value: "settings", label: "Settings" },
        { value: "exit", label: "Exit" },
      ],
    });
    if (isCancel(action) || action === "exit") {
      outro("No changes made.");
      return 0;
    }
    if (action === "skills") {
      const projects = new Map(
        inventory.projects.map((project) => [project.id, project.name]),
      );
      for (const observation of inventory.remoteObservations ?? [])
        for (const project of observation.projects)
          projects.set(project.id, project.name);
      const target = await select({
        message: "Which skills?",
        options: [
          { value: "global", label: "Global skills" },
          ...[...projects].map(([id, name]) => ({
            value: id,
            label: `${name} · ${id}`,
          })),
        ],
      });
      if (!isCancel(target))
        note(
          renderSkills(inventory, target === "global" ? undefined : target),
          "Skills",
        );
    }
    if (action === "changes") note(renderChanges(inventory), "Changes");
    if (action === "refresh") {
      const code = await run(["observe"]);
      if (code !== 0) return code;
      inventory = await load();
      note(renderDashboard(inventory), "Refreshed");
    }
    if (action === "settings") {
      const { runGuidedMenu } = await import("./menu.js");
      return runGuidedMenu(run);
    }
  }
}
