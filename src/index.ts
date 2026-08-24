import { defaultRuntime, runCli } from "./cli/app.js";

const code = await runCli(process.argv.slice(2), defaultRuntime());
process.exitCode = code;
