import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/usage-worker.ts"],
  noExternal: ["zod", "yaml"],
  format: ["esm"],
  clean: true,
  dts: false,
  sourcemap: true,
  banner: {
    js: "#!/usr/bin/env node\nimport { createRequire as createModuleRequire } from 'node:module';\nconst require = createModuleRequire(import.meta.url);",
  },
  outExtension: () => ({ js: ".mjs" }),
});
