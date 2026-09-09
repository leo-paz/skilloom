import { defaultRuntime } from "./cli/runtime.js";
import { usageCommand } from "./cli/usage.js";

const args = process.argv.slice(2);
if (args[0] === "usage") args.shift();
try {
  process.exitCode = await usageCommand(args, defaultRuntime());
} catch (error) {
  if (args[0] === "hook") process.exitCode = 0;
  else {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 3;
  }
}
