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
    `Global · ${skillSummary(inventory.globalSkills, "no skills")}`,
    `Drift · ${
      inventory.operations.length === 0
        ? "synced"
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
    for (const project of inventory.projects) {
      lines.push(
        `${project.name} · ${skillSummary(project.skills, "no skills")} · ${project.operations.length === 0 ? "synced" : countLabel(project.operations.length, "change")}`,
      );
    }
  }
  return lines.join("\n");
}

function renderSkills(inventory: MachineInventory): string {
  const lines = ["Global"];
  if (inventory.globalSkills.length === 0) lines.push("No global skills found");
  else {
    for (const skill of inventory.globalSkills) {
      lines.push(
        `${skill.installed ? "●" : "○"} ${skill.name} · ${skill.managed ? "managed" : "unmanaged"} · ${skill.agents.join(", ") || "unknown agents"}`,
      );
    }
  }
  for (const project of inventory.projects) {
    lines.push("", project.name);
    if (project.skills.length === 0) lines.push("No project skills found");
    else {
      for (const skill of project.skills) {
        lines.push(
          `${skill.installed ? "●" : "○"} ${skill.name} · ${skill.managed ? "managed" : "unmanaged"}`,
        );
      }
    }
  }
  return lines.join("\n");
}

function renderChanges(inventory: MachineInventory): string {
  if (inventory.operations.length === 0) return "No pending changes";
  return inventory.operations
    .map(
      (operation) =>
        `${operation.kind === "add" ? "+" : "-"} ${operation.skill.name} · ${operation.skill.scope}`,
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
  if (action === "skills") note(renderSkills(inventory), "Skills");
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
  outro("Done.");
  return 0;
}
