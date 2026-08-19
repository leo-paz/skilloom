import { cancel, intro, isCancel, outro, select } from "@clack/prompts";

export async function runGuidedMenu(
  run: (args: string[]) => Promise<number>,
): Promise<number> {
  intro("Skilloom");
  const action = await select({
    message: "What do you want to do?",
    options: [
      { value: "plan", label: "Review planned changes" },
      { value: "apply", label: "Apply configuration" },
      { value: "config", label: "Show configuration" },
      { value: "project", label: "Initialize this project" },
      { value: "update", label: "Update installed skills" },
      { value: "doctor", label: "Diagnose the local setup" },
    ],
  });
  if (isCancel(action)) {
    cancel("No changes made.");
    return 5;
  }
  const args = action === "project" ? ["project", "init"] : [action];
  const code = await run(args);
  outro(code === 0 ? "Done." : `Finished with exit code ${code}.`);
  return code;
}
