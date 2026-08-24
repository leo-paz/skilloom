import { cancel, intro, isCancel, outro, select, text } from "@clack/prompts";

async function promptText(message: string): Promise<string | undefined> {
  const value = await text({ message });
  if (isCancel(value)) return undefined;
  return value;
}

export async function runGuidedMenu(
  run: (args: string[]) => Promise<number>,
): Promise<number> {
  intro("Skilloom");
  const action = await select({
    message: "What do you want to do?",
    options: [
      { value: "plan", label: "Review planned changes" },
      { value: "apply", label: "Apply configuration" },
      { value: "profiles", label: "Manage global profiles" },
      { value: "machine", label: "Select this machine profile" },
      { value: "project", label: "Configure this project" },
      { value: "update", label: "Update installed skills" },
      { value: "doctor", label: "Diagnose the local setup" },
    ],
  });
  if (isCancel(action)) {
    cancel("No changes made.");
    return 5;
  }
  let args: string[] = [action];
  if (action === "profiles") {
    const profileAction = await select({
      message: "Profile action",
      options: [
        { value: "show", label: "Show configuration" },
        { value: "add", label: "Create an empty profile" },
        { value: "remove", label: "Remove an unused profile" },
        { value: "add-skill", label: "Add a skill to a profile" },
        { value: "remove-skill", label: "Remove a skill from a profile" },
      ],
    });
    if (isCancel(profileAction)) return 5;
    if (profileAction === "show") args = ["config"];
    else if (profileAction === "add" || profileAction === "remove") {
      const name = await promptText("Profile name");
      if (!name) return 5;
      args = [
        "config",
        profileAction === "add" ? "--add-profile" : "--remove-profile",
        name,
      ];
    } else {
      const profile = await promptText("Profile name");
      if (!profile) return 5;
      const skill = await promptText("Skill name");
      if (!skill) return 5;
      if (profileAction === "remove-skill") {
        args = ["config", "--remove-skill", skill, "--from-profile", profile];
      } else {
        const source = await promptText("Skill source");
        if (!source) return 5;
        const agent = await promptText("Agent name, for example codex");
        if (!agent) return 5;
        args = [
          "config",
          "--add-skill",
          skill,
          "--source",
          source,
          "--to-profile",
          profile,
          "--agent",
          agent,
        ];
      }
    }
  }
  if (action === "machine") {
    const name = await promptText("Existing profile name");
    if (!name) return 5;
    args = ["config", "--profile", name];
  }
  if (action === "project") {
    const projectAction = await select({
      message: "Project action",
      options: [
        { value: "init", label: "Initialize the project manifest" },
        { value: "add", label: "Add a required skill" },
        { value: "remove", label: "Remove a required skill" },
      ],
    });
    if (isCancel(projectAction)) return 5;
    if (projectAction === "init") args = ["project", "init"];
    else {
      const name = await promptText("Skill name");
      if (!name) return 5;
      if (projectAction === "remove") {
        args = ["project", "remove", "--skill", name];
      } else {
        const source = await promptText("Skill source");
        if (!source) return 5;
        const agent = await promptText("Agent name, for example codex");
        if (!agent) return 5;
        args = [
          "project",
          "add",
          "--source",
          source,
          "--skill",
          name,
          "--agent",
          agent,
        ];
      }
    }
  }
  const code = await run(args);
  outro(code === 0 ? "Done." : `Finished with exit code ${code}.`);
  return code;
}
